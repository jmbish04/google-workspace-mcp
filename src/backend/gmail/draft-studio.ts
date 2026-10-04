/**
 * @file gmail/draft-studio.ts
 * @description The draft studio's data layer: create a draft, append a
 * revision, record a comment, and finally hand the result to Gmail (as a draft)
 * or send it.
 *
 * Every revision stores the body as the Gmail-ready HTML `compose.ts` would
 * send — so what the page previews is what the recipient gets, and promoting or
 * sending re-uses those exact bytes rather than re-rendering from a different
 * source. The hidden reference id is minted once per draft and kept across
 * revisions, so iterating in the studio does not mint a new id each time.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import {
  emailDraftComments,
  emailDraftRevisions,
  emailDrafts,
  type EmailDraft,
  type EmailDraftComment,
  type EmailDraftRevision,
  type EmailDraftStatus,
} from "@db/schemas";
import { composeBody, type ComposeReport } from "@/backend/gmail/compose";
import { notifyDraftRoom } from "@/backend/gmail/draft-room-notify";
import { newEmailUuid } from "@/backend/gmail/tracking";
import { GmailService } from "@/backend/mcp/services/gmail";
// Import from `tiptap-email` (the pure serialiser), NOT `tiptap-html` — the
// latter pulls `@tiptap/html/server` → `happy-dom`, which cannot run in workerd.
import { tiptapToHtml, type TiptapDoc } from "@/shared/tiptap-email";

/** Body in any of the forms a caller may have. */
export interface StudioBodyInput {
  markdown?: string;
  html?: string;
  text?: string;
  /** A Tiptap document (ProseMirror JSON) from the frontend editor. */
  doc?: TiptapDoc;
}

export interface DraftWithHistory extends EmailDraft {
  revisions: EmailDraftRevision[];
  comments: EmailDraftComment[];
  /** The body currently in play (the highest revision), or null for an empty draft. */
  current: EmailDraftRevision | null;
}

/** Normalise any supported body form into the exact bytes that would be sent. */
export function renderStudioBody(input: StudioBodyInput, uuid: string): { html: string; text: string; report: ComposeReport } {
  const html = input.doc?.content?.length ? tiptapToHtml(input.doc) : input.html;
  return composeBody({ markdown: input.markdown, html, text: input.text }, { uuid });
}

function hasBody(input: StudioBodyInput): boolean {
  return Boolean(input.doc?.content?.length || input.markdown || input.html || input.text);
}

export interface CreateDraftInput extends StudioBodyInput {
  account?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  replyToMessageId?: string;
  threadId?: string;
  note?: string;
  createdBySub?: string;
}

/** Start a studio draft. An initial body is optional — revision 1 if supplied. */
export async function createStudioDraft(env: Env, input: CreateDraftInput): Promise<DraftWithHistory> {
  const db = getDb(env);
  const now = new Date();
  const id = crypto.randomUUID();
  const uuid = newEmailUuid();
  await db.insert(emailDrafts).values({
    id,
    account: input.account ?? null,
    toAddr: input.to ?? null,
    ccAddr: input.cc ?? null,
    bccAddr: input.bcc ?? null,
    subject: input.subject ?? null,
    replyToMessageId: input.replyToMessageId ?? null,
    threadId: input.threadId ?? null,
    status: "drafting",
    currentRevision: 0,
    uuid,
    createdBySub: input.createdBySub ?? null,
    createdAt: now,
    updatedAt: now,
  });
  if (hasBody(input)) {
    await addRevision(env, id, input, { source: "agent", note: input.note ?? "Initial draft" });
  }
  return (await getStudioDraft(env, id))!;
}

export interface RevisionMeta {
  source: "agent" | "human";
  note?: string | null;
}

/**
 * Append a revision. The revision number is taken from the draft row inside the
 * same statement sequence, and `email_draft_revisions` has a unique
 * `(draft_id, n)` index, so two concurrent writers cannot both claim the same
 * number — the loser's insert fails rather than silently overwriting.
 */
export async function addRevision(
  env: Env,
  draftId: string,
  body: StudioBodyInput,
  meta: RevisionMeta,
): Promise<{ revision: EmailDraftRevision; report: ComposeReport }> {
  const db = getDb(env);
  const [draft] = await db.select().from(emailDrafts).where(eq(emailDrafts.id, draftId)).limit(1);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  if (draft.status === "sent") throw new Error(`Draft ${draftId} has already been sent; revisions are closed.`);

  const rendered = renderStudioBody(body, draft.uuid ?? newEmailUuid());
  const n = draft.currentRevision + 1;
  const row = {
    id: crypto.randomUUID(),
    draftId,
    n,
    html: rendered.html,
    text: rendered.text,
    source: meta.source,
    note: meta.note ?? null,
    createdAt: new Date(),
  };
  await db.insert(emailDraftRevisions).values(row);
  await db
    .update(emailDrafts)
    .set({ currentRevision: n, updatedAt: new Date() })
    .where(eq(emailDrafts.id, draftId));
  await notifyDraftRoom(env, draftId, { type: "revision", n, source: meta.source, note: meta.note ?? null });
  return { revision: row, report: rendered.report };
}

/** Change the envelope (recipients / subject) without adding a revision. */
export async function updateDraftFields(
  env: Env,
  draftId: string,
  fields: Partial<Pick<EmailDraft, "toAddr" | "ccAddr" | "bccAddr" | "subject" | "account">>,
): Promise<void> {
  const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(patch).length) return;
  await getDb(env)
    .update(emailDrafts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(emailDrafts.id, draftId));
}

export async function getStudioDraft(env: Env, draftId: string): Promise<DraftWithHistory | null> {
  const db = getDb(env);
  const [draft] = await db.select().from(emailDrafts).where(eq(emailDrafts.id, draftId)).limit(1);
  if (!draft) return null;
  const [revisions, comments] = await Promise.all([
    db.select().from(emailDraftRevisions).where(eq(emailDraftRevisions.draftId, draftId)).orderBy(asc(emailDraftRevisions.n)),
    db.select().from(emailDraftComments).where(eq(emailDraftComments.draftId, draftId)).orderBy(asc(emailDraftComments.createdAt)),
  ]);
  return { ...draft, revisions, comments, current: revisions[revisions.length - 1] ?? null };
}

export async function listStudioDrafts(
  env: Env,
  opts: { status?: EmailDraftStatus[]; limit?: number } = {},
): Promise<EmailDraft[]> {
  const db = getDb(env);
  const where = opts.status?.length ? inArray(emailDrafts.status, opts.status) : undefined;
  return db
    .select()
    .from(emailDrafts)
    .where(where)
    .orderBy(desc(emailDrafts.updatedAt))
    .limit(Math.min(opts.limit ?? 25, 100));
}

export async function addComment(
  env: Env,
  draftId: string,
  input: { body: string; quote?: string | null; revision?: number },
): Promise<EmailDraftComment> {
  const db = getDb(env);
  const [draft] = await db.select().from(emailDrafts).where(eq(emailDrafts.id, draftId)).limit(1);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  const row = {
    id: crypto.randomUUID(),
    draftId,
    revision: input.revision ?? draft.currentRevision,
    quote: input.quote ?? null,
    body: input.body,
    resolved: false,
    createdAt: new Date(),
  };
  await db.insert(emailDraftComments).values(row);
  await notifyDraftRoom(env, draftId, { type: "comment", commentId: row.id });
  return row;
}

export async function resolveComments(env: Env, draftId: string, commentIds?: string[]): Promise<number> {
  const db = getDb(env);
  const where = commentIds?.length
    ? and(eq(emailDraftComments.draftId, draftId), inArray(emailDraftComments.id, commentIds))
    : eq(emailDraftComments.draftId, draftId);
  const rows = await db.select({ id: emailDraftComments.id }).from(emailDraftComments).where(where);
  if (!rows.length) return 0;
  await db.update(emailDraftComments).set({ resolved: true }).where(where);
  await notifyDraftRoom(env, draftId, { type: "comment", commentId: rows[0].id });
  return rows.length;
}

export async function setDraftStatus(
  env: Env,
  draftId: string,
  status: EmailDraftStatus,
  extra: Partial<Pick<EmailDraft, "gmailDraftId" | "sentMessageId" | "threadId">> = {},
): Promise<void> {
  await getDb(env)
    .update(emailDrafts)
    .set({ status, ...extra, updatedAt: new Date() })
    .where(eq(emailDrafts.id, draftId));
  await notifyDraftRoom(env, draftId, { type: "status", status });
}

/** Throw unless the draft is ready to leave the studio. */
export function assertSendable(draft: DraftWithHistory): asserts draft is DraftWithHistory & { current: EmailDraftRevision } {
  if (draft.status === "sent") throw new Error("This draft has already been sent.");
  if (!draft.current) throw new Error("This draft has no body yet — add a revision first.");
  if (!draft.replyToMessageId && !draft.toAddr) throw new Error("This draft has no recipients.");
  if (!draft.replyToMessageId && !draft.subject) throw new Error("This draft has no subject.");
}

/* ------------------------------------------------------- leaving the studio */

/**
 * Ship the current revision to Gmail as a real draft, so the human can do the
 * final look in Gmail itself. Idempotent-ish: a second call creates a second
 * Gmail draft, so the caller should check `gmailDraftId` first.
 */
export async function promoteStudioDraft(
  env: Env,
  draftId: string,
): Promise<{ gmailDraftId: string; revision: number }> {
  const draft = await getStudioDraft(env, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  assertSendable(draft);
  const gmail = new GmailService(env, draft.account ?? "");
  const opts = {
    cc: draft.ccAddr ?? undefined,
    bcc: draft.bccAddr ?? undefined,
    html: draft.current.html,
    uuid: draft.uuid ?? undefined,
    // The studio already rendered the exact bytes to ship.
    prebuilt: true,
  };
  const created = draft.replyToMessageId
    ? await gmail.createReplyDraft(draft.replyToMessageId, draft.current.text, opts)
    : await gmail.createDraft(draft.toAddr!, draft.subject!, draft.current.text, opts);
  await setDraftStatus(env, draftId, "in_gmail", { gmailDraftId: created.id });
  return { gmailDraftId: created.id, revision: draft.current.n };
}

/** Send the current revision. The studio draft is closed to further revisions. */
export async function sendStudioDraft(
  env: Env,
  draftId: string,
): Promise<{ messageId: string; threadId?: string; revision: number }> {
  const draft = await getStudioDraft(env, draftId);
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  assertSendable(draft);
  const gmail = new GmailService(env, draft.account ?? "");
  const sent = await gmail.send(draft.toAddr ?? "", draft.subject ?? "", draft.current.text, {
    cc: draft.ccAddr ?? undefined,
    bcc: draft.bccAddr ?? undefined,
    html: draft.current.html,
    uuid: draft.uuid ?? undefined,
    prebuilt: true,
    replyToMessageId: draft.replyToMessageId ?? undefined,
    threadId: draft.threadId ?? undefined,
  });
  await setDraftStatus(env, draftId, "sent", { sentMessageId: sent.id, threadId: sent.threadId ?? draft.threadId });
  return { messageId: sent.id, threadId: sent.threadId, revision: draft.current.n };
}
