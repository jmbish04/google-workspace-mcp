/**
 * @file gmail/thread-index.ts
 * @description Read-through cache for Gmail threads and messages, in Postgres (schema `gws`).
 *
 * A Gmail message never changes once it is sent, so we fetch each one once.
 * `gmail_get_thread` asks Gmail for the thread skeleton (ids + labels, no bodies),
 * diffs it against `gws.gmail_messages`, fetches only the messages we lack, and
 * answers from Postgres. The result carries an `index` block ("Gmail has 15, we hold
 * 15, complete") so a short cache is visible instead of silent.
 *
 * Identity: every row has an integer identity PK; the Gmail ids are kept beside it and
 * stay the ids the tools speak. People (one row per human) link to messages through
 * `message_participants` with a from/to/cc/bcc role. Attachments are registered per
 * (message, Gmail part), uploaded to Drive once, and their extracted text lives in
 * `file_contents` keyed by sha256 so a repeated file is recorded but never reprocessed.
 *
 * Connections: `postgres.js` through Hyperdrive, one client per top-level call, always
 * closed (see db/postgres.ts for why). Drafts are read live and never stored.
 */
import type postgres from "postgres";

import { getSql } from "@/backend/db/postgres";
import type { GmailService } from "@/backend/mcp/services/gmail";

import { extractAttachmentParts, junkReason, type AttachmentPart } from "./attachments";
import { uploadMessageAttachments, type DriveAttachment } from "./attachment-drive";
import { extractBody, type BodyFormat } from "./body-extract";
import { parseRawMessage } from "./parse-message";
import { indexStatus, planThreadSync, type IndexStatus } from "./thread-plan";

/** Most messages fetched in full per call. A longer thread finishes over the next call. */
export const MAX_FETCH_PER_CALL = 60;
const CONCURRENCY = 5;
const MAX_BODY_CHARS = 5_000_000;
/**
 * A Postgres text[] literal. postgres.js is configured with fetch_types:false (see
 * db/postgres.ts), which leaves it without array serializers, so `sql.array()` would send a
 * bare string ("malformed array literal"). Pass this with a `::text[]` cast instead.
 * Reading is the mirror image: select `to_jsonb(col)` or an array column arrives as '{a,b}'.
 */
export const pgTextArray = (a: readonly string[]): string =>
  "{" + a.map((x) => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";

type Raw = Record<string, any>;
export type Sql = postgres.Sql;

/** Run `fn` with a per-request client and close it afterwards. */
export async function withSql<T>(env: Env, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = getSql(env);
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface MessageHeaders {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

// ---------------------------------------------------------------------------
// Views (what the tools return)
// ---------------------------------------------------------------------------

export interface NoteView {
  /** gws.notes.id. */
  id: number;
  scope: "thread" | "message" | "attachment";
  /** Gmail thread id. */
  threadId: string;
  /** Gmail message id. */
  messageId: string | null;
  /** gws.gmail_attachments.id. */
  attachmentId: number | null;
  note: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentView {
  /** gws.gmail_attachments.id: pass it as `attachmentId` to gmail_note_add. */
  id: number | null;
  filename: string;
  mimeType: string;
  size: number;
  /** stored = in Drive. pending = known but not uploaded. live = a draft, not tracked. */
  status: "stored" | "pending" | "live";
  driveId?: string;
  driveUrl?: string | null;
  sha256_hash?: string;
  doc_text?: string;
  googleDriveId?: string;
  googleMimeType?: string;
  /** Notes on this attachment. */
  notes: NoteView[];
}

export interface MessageView {
  /** Gmail message id. */
  id: string;
  /** gws.gmail_messages.id. */
  pk?: number;
  /** Gmail thread id. */
  threadId: string;
  labelIds: string[];
  snippet: string | null;
  internalDate: number | null;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  body: string;
  urls: { label: string; href: string }[];
  attachments: AttachmentView[];
  notes: NoteView[];
  /** True for a draft: read live, not cached, not noted. */
  draft?: true;
}

interface NoteRow {
  id: number;
  gmail_thread_id: string;
  gmail_message_id: string | null;
  attachment_id: number | null;
  body: string;
  author: string;
  created_at: Date;
  updated_at: Date;
}

export function noteView(r: NoteRow): NoteView {
  return {
    id: r.id,
    scope: r.attachment_id ? "attachment" : r.gmail_message_id ? "message" : "thread",
    threadId: r.gmail_thread_id,
    messageId: r.gmail_message_id,
    attachmentId: r.attachment_id,
    note: r.body,
    author: r.author,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

interface AttachmentRow {
  id: number;
  message_id: number;
  gmail_part_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  is_junk: boolean;
  drive_file_id: string | null;
  drive_url: string | null;
  google_drive_id: string | null;
  google_mime_type: string | null;
  extracted_text: string | null;
}

export function attachmentView(r: AttachmentRow, notes: NoteView[] = []): AttachmentView {
  return {
    notes,
    id: r.id,
    filename: r.filename ?? "",
    mimeType: r.mime_type ?? "application/octet-stream",
    size: r.size_bytes ?? 0,
    status: r.drive_file_id ? "stored" : "pending",
    ...(r.drive_file_id
      ? {
          driveId: r.drive_file_id,
          driveUrl: r.drive_url,
          sha256_hash: r.sha256 ?? "",
          doc_text: r.extracted_text ?? "",
          ...(r.google_drive_id ? { googleDriveId: r.google_drive_id, googleMimeType: r.google_mime_type ?? undefined } : {}),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Parsing a raw Gmail message
// ---------------------------------------------------------------------------

export function pickHeaders(payload: Raw | undefined): MessageHeaders {
  const h = (n: string): string | undefined =>
    (payload?.headers as { name?: string; value?: string }[] | undefined)?.find((x) => x?.name?.toLowerCase() === n)?.value;
  const out: MessageHeaders = {};
  const set = <K extends keyof MessageHeaders>(k: K, v: string | undefined) => {
    if (v) out[k] = v;
  };
  set("from", h("from"));
  set("to", h("to"));
  set("cc", h("cc"));
  set("bcc", h("bcc"));
  set("subject", h("subject"));
  set("date", h("date"));
  set("messageId", h("message-id"));
  set("inReplyTo", h("in-reply-to"));
  set("references", h("references"));
  return out;
}

/** A message read straight from Gmail (drafts), in the same shape as a stored one. */
export function liveView(raw: Raw): MessageView {
  const p = parseRawMessage(raw);
  const { body, urls } = extractBody(raw.payload, "text");
  const hdr = pickHeaders(raw.payload);
  return {
    id: p.id,
    threadId: p.threadId,
    labelIds: p.labelIds,
    snippet: p.snippet,
    internalDate: p.internalDate,
    subject: hdr.subject,
    from: hdr.from,
    to: hdr.to,
    cc: hdr.cc,
    date: hdr.date,
    body,
    urls,
    attachments: extractAttachmentParts(raw.payload)
      .filter((a) => junkReason(a) === null)
      .map((a) => ({ id: null, filename: a.filename, mimeType: a.mimeType, size: a.size, status: "live" as const, notes: [] })),
    notes: [],
    draft: true,
  };
}

// ---------------------------------------------------------------------------
// Accounts, threads, storing
// ---------------------------------------------------------------------------

const isConsumer = (email: string) => /@(gmail|googlemail)\.com$/i.test(email);

/** `gws.accounts.id` for a mailbox, created on first sight. */
export async function accountId(sql: Sql, email: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    insert into gws.accounts (email, kind)
    values (${email}, ${isConsumer(email) ? "consumer" : "workspace"}::gws.account_kind)
    on conflict (email) do update set email = excluded.email
    returning id`;
  return rows[0].id;
}

/** Make sure a thread row exists and return its integer id. Never overwrites better data with worse. */
async function ensureThread(
  sql: Sql,
  accId: number,
  t: { gmailThreadId: string; subject?: string | null; snippet?: string | null; labelIds?: string[]; lastMessageAt?: number | null },
): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    insert into gws.gmail_threads (account_id, gmail_thread_id, subject, snippet, label_ids, last_message_at)
    values (${accId}, ${t.gmailThreadId}, ${t.subject ?? null}, ${t.snippet ?? null},
            ${pgTextArray(t.labelIds ?? [])}::text[], ${t.lastMessageAt ? new Date(t.lastMessageAt) : null})
    on conflict (account_id, gmail_thread_id) do update set
      subject = coalesce(gws.gmail_threads.subject, excluded.subject),
      last_message_at = greatest(gws.gmail_threads.last_message_at, excluded.last_message_at)
    returning id`;
  return rows[0].id;
}

/**
 * Store one full Gmail message in one transaction: thread row, message row, people +
 * participants, and one registry row per attachment part. Safe to repeat (upserts).
 */
export async function storeMessage(sql: Sql, accId: number, raw: Raw): Promise<void> {
  const p = parseRawMessage(raw);
  if (!p.id || !p.threadId) throw new Error("message has no id/threadId");
  const { body: fullBody, urls } = extractBody(raw.payload, "text");
  const body = fullBody.slice(0, MAX_BODY_CHARS);
  const headers = pickHeaders(raw.payload);
  const parts = extractAttachmentParts(raw.payload);

  await sql.begin(async (tx) => {
    const threadPk = await ensureThread(tx as unknown as Sql, accId, {
      gmailThreadId: p.threadId,
      subject: p.subject,
      snippet: p.snippet,
      labelIds: p.labelIds,
      lastMessageAt: p.internalDate,
    });
    const msg = await tx<{ id: number }[]>`
      insert into gws.gmail_messages
        (thread_id, account_id, gmail_thread_id, gmail_message_id, rfc822_message_id, in_reply_to,
         subject, snippet, internal_date, label_ids, headers, body_text, urls, size_bytes, gone_at)
      values (${threadPk}, ${accId}, ${p.threadId}, ${p.id}, ${headers.messageId ?? null}, ${headers.inReplyTo ?? null},
              ${p.subject}, ${p.snippet}, ${p.internalDate ? new Date(p.internalDate) : null},
              ${pgTextArray(p.labelIds)}::text[], ${tx.json(headers as never)}, ${body}, ${tx.json(urls as never)},
              ${body.length}, null)
      on conflict (account_id, gmail_message_id) do update set
        subject = excluded.subject, snippet = excluded.snippet, internal_date = excluded.internal_date,
        label_ids = excluded.label_ids, headers = excluded.headers, body_text = excluded.body_text,
        urls = excluded.urls, size_bytes = excluded.size_bytes, gone_at = null
      returning id`;
    const messagePk = msg[0].id;

    await tx`delete from gws.message_participants where message_id = ${messagePk}`;
    for (const c of p.contacts) {
      if (!c.email) continue;
      const person = await tx<{ id: number }[]>`
        insert into gws.people (email, display_name, first_name, last_name)
        values (${c.email}, ${[c.firstName, c.lastName].filter(Boolean).join(" ") || null}, ${c.firstName || null}, ${c.lastName || null})
        on conflict (email) do update set
          display_name = coalesce(gws.people.display_name, excluded.display_name),
          first_name = coalesce(gws.people.first_name, excluded.first_name),
          last_name = coalesce(gws.people.last_name, excluded.last_name)
        returning id`;
      await tx`
        insert into gws.message_participants (message_id, person_id, role)
        values (${messagePk}, ${person[0].id}, ${c.type}::gws.participant_role)
        on conflict (message_id, person_id, role) do nothing`;
    }

    for (const part of parts) {
      const reason = junkReason(part);
      await tx`
        insert into gws.gmail_attachments
          (message_id, gmail_part_id, gmail_attachment_id, filename, mime_type, size_bytes, is_junk, junk_reason, status)
        values (${messagePk}, ${part.partId || part.attachmentId}, ${part.attachmentId}, ${part.filename || null},
                ${part.mimeType}, ${part.size}, ${reason !== null}, ${reason}, ${reason !== null ? "skipped_junk" : "pending"}::gws.attachment_status)
        on conflict (message_id, gmail_part_id) do update set
          gmail_attachment_id = excluded.gmail_attachment_id`;
    }
  });
}

async function inChunks<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.allSettled(items.slice(i, i + size).map(fn))));
  return out;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  status: IndexStatus;
  /** Full payloads fetched on this call, keyed by Gmail message id (fresh attachment ids). */
  payloads: Map<string, Raw>;
  /** Drafts, read live. */
  drafts: MessageView[];
  subject: string | null;
  threadPk: number;
  accountPk: number;
}

/**
 * Reconcile one thread: ask Gmail for the skeleton, store what is missing, refresh
 * labels, mark vanished messages gone, and record the counts on `gws.gmail_threads`.
 * A failed fetch is reported in `status.fetchErrors` and retried on the next call.
 */
export async function syncThreadWith(sql: Sql, gmail: GmailService, email: string, gmailThreadId: string): Promise<SyncOutcome> {
  const accId = await accountId(sql, email);
  const meta = await gmail.getThreadMeta(gmailThreadId);
  const cached = await sql<{ id: string; label_ids: string[]; headers: Record<string, unknown>; gone_at: Date | null }[]>`
    select gmail_message_id as id, to_jsonb(label_ids) as label_ids, headers, gone_at
    from gws.gmail_messages where account_id = ${accId} and gmail_thread_id = ${gmailThreadId}`;
  const plan = planThreadSync(
    meta.messages,
    cached.map((c) => ({
      id: c.id,
      labelIds: c.label_ids,
      hydrated: Object.keys(c.headers ?? {}).length > 0,
      goneAt: c.gone_at ? c.gone_at.getTime() : null,
    })),
  );

  const payloads = new Map<string, Raw>();
  const errors: { id: string; error: string }[] = [];
  const fetchOne = async (id: string) => ({ id, raw: (await gmail.getRawMessage(id)) as Raw });

  let fetched = 0;
  const batchIds = plan.toFetch.slice(0, MAX_FETCH_PER_CALL);
  for (const [i, res] of (await inChunks(batchIds, CONCURRENCY, fetchOne)).entries()) {
    if (res.status === "rejected") {
      errors.push({ id: batchIds[i], error: res.reason instanceof Error ? res.reason.message : String(res.reason) });
      continue;
    }
    try {
      await storeMessage(sql, accId, res.value.raw);
      payloads.set(res.value.id, res.value.raw);
      fetched++;
    } catch (e) {
      errors.push({ id: res.value.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const u of plan.labelUpdates) {
    await sql`update gws.gmail_messages set label_ids = ${pgTextArray(u.labelIds)}::text[]
              where account_id = ${accId} and gmail_message_id = ${u.id}`;
  }
  if (plan.gone.length) {
    await sql`update gws.gmail_messages set gone_at = now()
              where account_id = ${accId} and gmail_message_id = any(${pgTextArray(plan.gone)}::text[])`;
  }
  if (plan.revived.length) {
    await sql`update gws.gmail_messages set gone_at = null
              where account_id = ${accId} and gmail_message_id = any(${pgTextArray(plan.revived)}::text[])`;
  }

  const drafts: MessageView[] = [];
  for (const res of await inChunks(plan.drafts, CONCURRENCY, async (id) => (await gmail.getRawMessage(id)) as Raw)) {
    if (res.status === "fulfilled") drafts.push(liveView(res.value));
  }

  const status = indexStatus(plan, {
    stored: plan.gmailCount - plan.drafts.length - plan.toFetch.length + fetched,
    fetched,
    errors,
    now: Date.now(),
  });
  const subject =
    [...payloads.values()].map((r) => pickHeaders(r.payload).subject).find(Boolean) ?? drafts.find((d) => d.subject)?.subject ?? null;
  const lastMessageAt = Math.max(0, ...meta.messages.map((m) => Number(m.internalDate) || 0)) || null;
  const threadPk = await ensureThread(sql, accId, { gmailThreadId, subject, lastMessageAt });
  await sql`
    update gws.gmail_threads set
      history_id = ${meta.historyId ?? null},
      gmail_message_count = ${status.gmailCount},
      message_count = ${status.indexedCount},
      synced_at = ${new Date(status.syncedAt)},
      metadata = ${sql.json({ messageIds: meta.messages.map((m) => m.id) } as never)}
    where id = ${threadPk}`;
  return { status, payloads, drafts, subject, threadPk, accountPk: accId };
}

/** `syncThreadWith` on its own connection. */
export function syncThread(env: Env, gmail: GmailService, email: string, gmailThreadId: string): Promise<SyncOutcome> {
  return withSql(env, (sql) => syncThreadWith(sql, gmail, email, gmailThreadId));
}

// ---------------------------------------------------------------------------
// Attachments → Drive, once
// ---------------------------------------------------------------------------

const toDrive = (r: AttachmentRow): DriveAttachment => ({
  id: r.id,
  filename: r.filename ?? "",
  driveId: r.drive_file_id ?? "",
  driveUrl: r.drive_url,
  mimetype: r.mime_type ?? "",
  size: r.size_bytes ?? 0,
  sha256_hash: r.sha256 ?? "",
  doc_text: r.extracted_text ?? "",
});

export interface AttachmentCtx {
  gmail: GmailService;
  ref: string;
  accountKey: string;
}

/**
 * Upload every message's not-yet-stored attachments to Drive and register them.
 * A message whose attachments are all registered costs nothing (no Gmail call, no
 * Drive call). A failure on one message is returned, not thrown, so the agent
 * still gets the thread. Returns the Drive folder in use.
 */
export async function ensureThreadAttachments(
  env: Env,
  sql: Sql,
  ctx: AttachmentCtx,
  o: { accountPk: number; threadPk: number; subject: string; payloads: Map<string, Raw>; messageIds?: string[] },
): Promise<{ folderId: string | null; errors: { messageId: string; error: string }[] }> {
  const thread = (await sql<{ folder: string | null }[]>`select drive_folder_id as folder from gws.gmail_threads where id = ${o.threadPk}`)[0];
  let folderId: string | null = thread?.folder ?? null;
  const errors: { messageId: string; error: string }[] = [];

  const rows = await sql<(AttachmentRow & { gmail_message_id: string })[]>`
    select a.*, m.gmail_message_id, fc.extracted_text
    from gws.gmail_attachments a
    join gws.gmail_messages m on m.id = a.message_id
    left join gws.file_contents fc on fc.id = a.content_id
    where m.thread_id = ${o.threadPk} and m.gone_at is null`;
  const byMessage = new Map<string, (AttachmentRow & { gmail_message_id: string })[]>();
  for (const a of rows) {
    if (o.messageIds && !o.messageIds.includes(a.gmail_message_id)) continue;
    byMessage.set(a.gmail_message_id, [...(byMessage.get(a.gmail_message_id) ?? []), a]);
  }

  for (const [messageId, atts] of byMessage) {
    const keep = atts.filter((a) => !a.is_junk);
    if (keep.every((a) => a.drive_file_id)) continue;
    try {
      const payload = o.payloads.get(messageId)?.payload ?? ((await ctx.gmail.getRawMessage(messageId)) as Raw).payload;
      const byPart = new Map(keep.filter((a) => a.drive_file_id).map((a) => [a.gmail_part_id, a]));
      const up = await uploadMessageAttachments(env, ctx.ref, ctx.accountKey, {
        messageId,
        payload,
        subject: o.subject,
        folderId: folderId ?? undefined,
        gmail: ctx.gmail,
        cache: {
          get: (part) => {
            const r = byPart.get(part.partId || part.attachmentId);
            return r && toDrive(r);
          },
          put: async (part: AttachmentPart, u: DriveAttachment) => {
            const partKey = part.partId || part.attachmentId;
            const content = u.sha256_hash
              ? (
                  await sql<{ id: number }[]>`
                    insert into gws.file_contents (sha256, size_bytes, mime_type, extracted_text, processed_at)
                    values (${u.sha256_hash}, ${u.size}, ${u.mimetype}, ${u.doc_text || null}, now())
                    on conflict (sha256) do update set
                      extracted_text = coalesce(gws.file_contents.extracted_text, excluded.extracted_text),
                      processed_at = coalesce(gws.file_contents.processed_at, excluded.processed_at)
                    returning id`
                )[0].id
              : null;
            await sql`
              update gws.gmail_attachments a set
                drive_file_id = ${u.driveId}, drive_url = ${u.driveUrl}, sha256 = ${u.sha256_hash || null},
                content_id = ${content}, google_drive_id = ${u.googleDriveId ?? null}, google_mime_type = ${u.googleMimeType ?? null},
                gmail_attachment_id = ${part.attachmentId},
                status = ${u.doc_text ? "extracted" : "staged"}::gws.attachment_status
              from gws.gmail_messages m
              where a.message_id = m.id and m.account_id = ${o.accountPk} and m.gmail_message_id = ${messageId}
                and a.gmail_part_id = ${partKey}`;
          },
        },
      });
      if (up.folderId) folderId = up.folderId;
    } catch (e) {
      errors.push({ messageId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (folderId && folderId !== thread?.folder) {
    await sql`update gws.gmail_threads set drive_folder_id = ${folderId} where id = ${o.threadPk}`;
  }
  return { folderId, errors };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  gmail_message_id: string;
  gmail_thread_id: string;
  subject: string | null;
  snippet: string | null;
  label_ids: string[];
  internal_date: Date | null;
  headers: MessageHeaders;
  body_text: string | null;
  urls: { label: string; href: string }[];
}

async function loadParts(sql: Sql, threadPk: number, onlyMessagePk?: number) {
  const msgs = await sql<MessageRow[]>`
    select id, gmail_message_id, gmail_thread_id, subject, snippet, to_jsonb(label_ids) as label_ids, internal_date, headers, body_text, urls
    from gws.gmail_messages
    where thread_id = ${threadPk} and gone_at is null ${onlyMessagePk ? sql`and id = ${onlyMessagePk}` : sql``}
    order by internal_date asc nulls last, id asc`;
  const atts = await sql<AttachmentRow[]>`
    select a.*, fc.extracted_text
    from gws.gmail_attachments a
    join gws.gmail_messages m on m.id = a.message_id
    left join gws.file_contents fc on fc.id = a.content_id
    where m.thread_id = ${threadPk}
    order by a.id`;
  const notes = await sql<NoteRow[]>`
    select n.id, t.gmail_thread_id, m.gmail_message_id, n.attachment_id, n.body, n.author, n.created_at, n.updated_at
    from gws.notes n
    join gws.gmail_threads t on t.id = n.thread_id
    left join gws.gmail_messages m on m.id = n.message_id
    where n.thread_id = ${threadPk}
    order by n.created_at, n.id`;
  return { msgs, atts, notes };
}

/** Message notes sit on the message; attachment notes sit on that attachment. */
export function assembleMessages(msgs: MessageRow[], atts: AttachmentRow[], notes: NoteRow[]): MessageView[] {
  return msgs.map((m) => {
    const h = m.headers ?? {};
    return {
      id: m.gmail_message_id,
      pk: m.id,
      threadId: m.gmail_thread_id,
      labelIds: m.label_ids ?? [],
      snippet: m.snippet,
      internalDate: m.internal_date ? m.internal_date.getTime() : null,
      subject: h.subject ?? m.subject ?? undefined,
      from: h.from,
      to: h.to,
      cc: h.cc,
      date: h.date,
      body: m.body_text ?? "",
      urls: m.urls ?? [],
      attachments: atts
        .filter((a) => a.message_id === m.id && !a.is_junk)
        .map((a) => attachmentView(a, notes.filter((n) => n.attachment_id === a.id).map(noteView))),
      notes: notes.filter((n) => n.gmail_message_id === m.gmail_message_id && !n.attachment_id).map(noteView),
    };
  });
}

export interface ThreadResult {
  id: string;
  /** gws.gmail_threads.id. */
  pk: number;
  subject: string | null;
  historyId: string | null;
  index: IndexStatus;
  attachmentsFolderId: string | null;
  attachmentErrors: { messageId: string; error: string }[];
  /** Notes on the thread itself (message and attachment notes ride on those). */
  notes: NoteView[];
  messages: MessageView[];
}

/**
 * The whole `gmail_get_thread` flow: sync, upload pending attachments (unless
 * `includeAttachments` is false), then answer from Postgres with the live drafts last.
 */
export async function getThreadIndexed(
  env: Env,
  ctx: AttachmentCtx & { email: string },
  o: { threadId: string; includeAttachments: boolean },
): Promise<ThreadResult> {
  return withSql(env, async (sql) => {
    const sync = await syncThreadWith(sql, ctx.gmail, ctx.email, o.threadId);
    let attachmentErrors: { messageId: string; error: string }[] = [];
    if (o.includeAttachments) {
      const up = await ensureThreadAttachments(env, sql, ctx, {
        accountPk: sync.accountPk,
        threadPk: sync.threadPk,
        subject: sync.subject ?? "(no subject)",
        payloads: sync.payloads,
      });
      attachmentErrors = up.errors;
    }
    const { msgs, atts, notes } = await loadParts(sql, sync.threadPk);
    const thread = (
      await sql<{ subject: string | null; history_id: string | null; drive_folder_id: string | null }[]>`
        select subject, history_id, drive_folder_id from gws.gmail_threads where id = ${sync.threadPk}`
    )[0];
    return {
      id: o.threadId,
      pk: sync.threadPk,
      subject: thread?.subject ?? sync.subject,
      historyId: thread?.history_id ?? null,
      index: sync.status,
      attachmentsFolderId: thread?.drive_folder_id ?? null,
      attachmentErrors,
      notes: notes.filter((n) => !n.gmail_message_id).map(noteView),
      messages: [...assembleMessages(msgs, atts, notes), ...sync.drafts],
    };
  });
}

/** One stored message as a view, or null when we have not stored it yet. */
export async function loadMessageView(sql: Sql, accId: number, gmailMessageId: string): Promise<MessageView | null> {
  const head = (
    await sql<{ id: number; thread_id: number }[]>`
      select id, thread_id from gws.gmail_messages where account_id = ${accId} and gmail_message_id = ${gmailMessageId}`
  )[0];
  if (!head) return null;
  const { msgs, atts, notes } = await loadParts(sql, head.thread_id, head.id);
  return assembleMessages(msgs, atts, notes)[0] ?? null;
}

/** Contacts for a stored message (from/to/cc/bcc), as `gmail_get_message` has always returned them. */
export async function loadContacts(sql: Sql, messagePk: number) {
  return sql<{ firstName: string | null; lastName: string | null; email: string; type: string }[]>`
    select p.first_name as "firstName", p.last_name as "lastName", p.email::text as email, mp.role::text as type
    from gws.message_participants mp join gws.people p on p.id = mp.person_id
    where mp.message_id = ${messagePk}
    order by mp.id`;
}

/**
 * The whole `gmail_get_message` flow. A message we hold is answered from Postgres with
 * no Gmail call (plain-text body only; html/rfc re-read Gmail because we keep only
 * text). A message we lack is fetched once and stored. Drafts are read live.
 */
export async function getMessageIndexed(
  env: Env,
  ctx: AttachmentCtx & { email: string },
  o: { id: string; format: BodyFormat; includeAttachmentText: boolean },
) {
  return withSql(env, async (sql) => {
    const accId = await accountId(sql, ctx.email);
    let view = await loadMessageView(sql, accId, o.id);
    const cached = view != null;
    let raw: Raw | undefined;
    let contacts: Awaited<ReturnType<typeof loadContacts>> | ReturnType<typeof parseRawMessage>["contacts"] = [];

    if (!view) {
      raw = (await ctx.gmail.getRawMessage(o.id)) as Raw;
      if ((raw.labelIds as string[] | undefined)?.includes("DRAFT")) {
        view = liveView(raw);
        contacts = parseRawMessage(raw).contacts;
      } else {
        await storeMessage(sql, accId, raw);
        view = await loadMessageView(sql, accId, o.id);
        if (!view) throw new Error(`message ${o.id} could not be stored`);
      }
    }

    let attachmentErrors: { messageId: string; error: string }[] = [];
    if (!view.draft) {
      const threadPk = (
        await sql<{ thread_id: number }[]>`select thread_id from gws.gmail_messages where id = ${view.pk as number}`
      )[0].thread_id;
      if (o.includeAttachmentText) {
        const up = await ensureThreadAttachments(env, sql, ctx, {
          accountPk: accId,
          threadPk,
          subject: view.subject ?? "(no subject)",
          payloads: raw ? new Map([[o.id, raw]]) : new Map(),
          messageIds: [o.id],
        });
        attachmentErrors = up.errors;
        view = (await loadMessageView(sql, accId, o.id)) ?? view;
      }
      contacts = await loadContacts(sql, view.pk as number);
    }

    let { body, urls } = view;
    let bodyFormat: BodyFormat = "text";
    if (o.format !== "text") {
      raw ??= (await ctx.gmail.getRawMessage(o.id)) as Raw;
      const rfc = o.format === "rfc" ? await ctx.gmail.getMessageRfc(o.id) : undefined;
      ({ body, urls, bodyFormat } = extractBody(raw.payload, o.format, rfc));
    }
    return { ...view, contacts, body, bodyFormat, urls, cached, attachmentErrors };
  });
}
