import { eq } from "drizzle-orm";

import { googleJson } from "../googleClient";
import { getDb } from "@/db";
import { globalConfig } from "@db/schemas";
import { buildOutgoingRaw } from "@/backend/gmail/build-outgoing";
import { sendRawMessage, createRawDraft } from "@/backend/gmail/upload-transport";
import { formatAddress } from "@/backend/gmail/mime";
import { newEmailUuid, recordEmail, upsertEmailRecord } from "@/backend/gmail/tracking";
import { extractBody } from "@/backend/gmail/body-extract";
import { extractAttachmentParts } from "@/backend/gmail/attachments";
import { mergeAddresses, mergeDraftBody, type DraftBodyMode } from "@/backend/gmail/draft-edit";
import { splitAddresses } from "@/backend/gmail/parse-message";
import type { ComposeReport } from "@/backend/gmail/compose";
import type { BlobInput, AttachmentSpec, AttachmentReportItem } from "@/backend/gmail/outgoing-attachments";

export type GmailMessage = { id: string; snippet: string; payload?: unknown };

/** Rich body + attachments accepted by send / draft helpers. */
export interface RichContent {
  /** Cc recipients (comma-separated). Honored on drafts and sends alike. */
  cc?: string;
  /** Bcc recipients (comma-separated). Honored on drafts and sends alike. */
  bcc?: string;
  /** Raw HTML body (sanitized + CSS-inlined for Gmail by the worker). */
  html?: string;
  /** Markdown body (rendered + inlined for Gmail by the worker). */
  markdown?: string;
  /**
   * Pre-minted tracking id. Set when the body already carries its hidden
   * `ref:<uuid>` (e.g. built by gmail/authored-html.ts), so the same id is logged
   * and no second ref is appended.
   */
  uuid?: string;
  /** Unified attachment specs: Drive files, inline blobs, or forced links. */
  attachments?: AttachmentSpec[];
  /** Legacy: Drive file ids to attach (auto-fallback to shared links over the size cap). */
  driveIds?: string[];
  /** Legacy: inline base64 blobs to attach (auto-fallback to shared links over the size cap). */
  blobs?: BlobInput[];
  /**
   * The `html` was already normalised and stamped upstream (e.g. by
   * `buildAuthoredBody`). Ship it byte-identical instead of re-normalising —
   * the authorship watermark signs exactly these bytes.
   */
  prebuilt?: boolean;
}

/** Pass the caller's attachment inputs through to the MIME builder. */
function attachmentOpts(opts?: RichContent): Pick<RichContent, "attachments" | "driveIds" | "blobs"> {
  return { attachments: opts?.attachments, driveIds: opts?.driveIds, blobs: opts?.blobs };
}

export type { AttachmentReportItem };

/** One attachment on a draft, as {@link GmailService.getDraft} surfaces it. */
export interface DraftAttachmentView {
  /** For `users.messages.attachments.get` on the draft's `messageId`. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** A regular attachment, or an image embedded in the body via `cid:`. */
  disposition: "attachment" | "inline";
  /** Inline images only — the `Content-ID`, angle brackets stripped. */
  contentId?: string;
}

/**
 * A Gmail draft read back `format=full` and parsed into the fields an editor
 * needs. `draftId` is stable for the life of the draft; `messageId` changes on
 * every update. Matches the cross-cutting contract (docs/gmail-draft-attachment-
 * transport-contract.md §1).
 */
export interface GmailDraftView {
  draftId: string;
  messageId: string;
  threadId: string;
  headers: {
    /** Verbatim `From`, display name included. */
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    /** Verbatim `In-Reply-To` Message-ID, angle brackets kept. */
    inReplyTo?: string;
    /** Verbatim `References`. */
    references?: string;
  };
  /** The one `ref:<uuid>` in the HTML part, or null if the draft carries none. */
  uuid: string | null;
  /** Ref markers found in the HTML part; anything but 1 is a defect worth showing. */
  refCount: number;
  /** The stored `text/html` part, as Gmail holds it. */
  html: string;
  /** The stored `text/plain` part. */
  text: string;
  attachments: DraftAttachmentView[];
}

/**
 * The edit applied by {@link GmailService.updateDraft}. Every field is optional;
 * an omitted field keeps the draft's current value. `to`/`cc`/`bcc` REPLACE the
 * header; `addCc`/`addBcc` append (de-duplicated). Existing attachments are
 * retained unless named in `removeAttachments`; `attachments` are added on top.
 */
export interface DraftUpdateInput {
  /** Body edit — `mode` defaults to `replace`. Omit entirely to keep the body. */
  body?: { mode?: DraftBodyMode } & { markdown?: string; html?: string; text?: string };
  /** REPLACE the `To` header (comma-separated). */
  to?: string;
  /** REPLACE the `Cc` header (comma-separated). */
  cc?: string;
  /** REPLACE the `Bcc` header (comma-separated). */
  bcc?: string;
  /** Append to `Cc`, de-duplicated case-insensitively — the one-call CC-add. */
  addCc?: string[];
  /** Append to `Bcc`, de-duplicated case-insensitively. */
  addBcc?: string[];
  subject?: string;
  /** Extra attachments ADDED to the retained ones. */
  attachments?: AttachmentSpec[];
  /** Drop a retained attachment by `filename` or `contentId` (case-insensitive). */
  removeAttachments?: string[];
}

/** Lowercased-name → value map of a Gmail payload's headers. */
function headerMap(headers: { name?: string; value?: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) if (h?.name) out[h.name.toLowerCase()] = h.value ?? "";
  return out;
}

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Extracts bare email addresses from a comma-separated header value, handling "Name <a@b.com>" forms.
function extractEmails(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const match = trimmed.match(/<([^>]+)>/);
      return (match ? match[1] : trimmed).trim();
    })
    .filter(Boolean);
}

/**
 * `global_config` key holding the sender display name. Either a plain string,
 * or `{ default?: string, byAccount?: { "<email>": "<name>" } }`. It is the
 * override: when set it wins over whatever Gmail's send-as settings say, which
 * is what makes the name fixable without touching Google.
 */
const SENDER_NAME_CONFIG = "email_sender_name";

/**
 * Cache for the Gmail send-as lookup ONLY — a Google API round trip that
 * changes about never.
 *
 * The `email_sender_name` override is deliberately NOT cached. Measured in
 * production 2026-10-03: with the whole resolved header cached for 10 minutes,
 * `set_sender_name` wrote the config, reported success, and outgoing mail kept
 * the old bare address — and because the cache is per-isolate there was no way
 * to invalidate it from the request that did the write. A config knob you
 * cannot observe working is worse than no knob. One D1 row read per outgoing
 * email is not a cost worth that confusion (D1 billing is storage, not reads).
 */
const sendAsNameCache = new Map<string, { name?: string; at: number }>();
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;

export class GmailService {
  constructor(private env: Env, private sub: string) {}

  /** The configured override for this account, if any. */
  private async configuredSenderName(email: string): Promise<string | undefined> {
    try {
      const row = (
        await getDb(this.env).select().from(globalConfig).where(eq(globalConfig.key, SENDER_NAME_CONFIG)).limit(1)
      )[0]?.value as string | { default?: string; byAccount?: Record<string, string> } | undefined;
      if (!row) return undefined;
      if (typeof row === "string") return row || undefined;
      return row.byAccount?.[email.toLowerCase()] ?? row.default ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The `From` header to send as: `"Justin Bishop" <justin@example.com>`.
   *
   * Without a display name the recipient's inbox shows a bare address, so this
   * is resolved on EVERY send and draft. Order: the `email_sender_name` config
   * override, then Gmail's own send-as `displayName` (the same name the Gmail
   * UI would put on the message). Best-effort — any lookup failure falls back
   * to the bare address and never blocks the send.
   *
   * The whole header is cached per (account, requested address) so the common
   * path costs no extra Google calls.
   */
  async fromHeader(preferredEmail?: string): Promise<string | undefined> {
    let email = preferredEmail;
    if (!email) {
      email = await this.getProfile()
        .then((p) => p.emailAddress)
        .catch(() => undefined);
    }
    if (!email) return preferredEmail;

    // Read fresh every time: this is the knob a human just turned, and it has
    // to take effect on the next message, not within ten minutes.
    let name = await this.configuredSenderName(email);
    if (!name) name = await this.sendAsDisplayName(email);
    return formatAddress(email, name);
  }

  /** Gmail's own send-as display name, cached — best-effort, never fatal. */
  private async sendAsDisplayName(email: string): Promise<string | undefined> {
    const key = `${this.sub}|${email.toLowerCase()}`;
    const hit = sendAsNameCache.get(key);
    if (hit && Date.now() - hit.at < SENDER_NAME_TTL_MS) return hit.name;
    let name: string | undefined;
    try {
      const out = await googleJson<{
        sendAs?: { sendAsEmail: string; displayName?: string; isDefault?: boolean; isPrimary?: boolean }[];
      }>(this.env, this.sub, `${BASE}/settings/sendAs`);
      const list = out.sendAs ?? [];
      const match =
        list.find((x) => x.sendAsEmail?.toLowerCase() === email.toLowerCase()) ??
        list.find((x) => x.isDefault) ??
        list.find((x) => x.isPrimary);
      name = match?.displayName?.trim() || undefined;
    } catch {
      // settings.sendAs may not be in the grant's scopes; the config override
      // above is the supported way to set the name then.
      name = undefined;
    }
    sendAsNameCache.set(key, { name, at: Date.now() });
    return name;
  }

  async listMessages(query?: string, maxResults = 20): Promise<{ messages: { id: string; threadId: string }[] }> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (query) params.set("q", query);
    const out = await googleJson<{ messages?: { id: string; threadId: string }[] }>(this.env, this.sub, `${BASE}/messages?${params}`);
    return { messages: out.messages ?? [] };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return googleJson<GmailMessage>(this.env, this.sub, `${BASE}/messages/${id}?format=full`);
  }

  /** List message ids carrying a specific label. */
  async listByLabel(labelId: string, maxResults = 25): Promise<{ messages: { id: string; threadId: string }[] }> {
    const params = new URLSearchParams({ maxResults: String(maxResults), labelIds: labelId });
    const out = await googleJson<{ messages?: { id: string; threadId: string }[] }>(this.env, this.sub, `${BASE}/messages?${params}`);
    return { messages: out.messages ?? [] };
  }

  /** Fetch the raw `format=full` message JSON (payload + headers) for parsing. */
  async getRawMessage(id: string): Promise<Record<string, unknown>> {
    return googleJson<Record<string, unknown>>(this.env, this.sub, `${BASE}/messages/${id}?format=full`);
  }

  /** Fetch the whole RFC822 message as a base64url string (`format=raw`). */
  async getMessageRfc(id: string): Promise<string> {
    const out = await googleJson<{ raw?: string }>(this.env, this.sub, `${BASE}/messages/${id}?format=raw`);
    return out.raw ?? "";
  }

  /** Fetch attachment bytes (base64url `data`) for a message part. */
  async getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    return googleJson<{ data: string; size: number }>(
      this.env,
      this.sub,
      `${BASE}/messages/${messageId}/attachments/${attachmentId}`,
    );
  }

  /**
   * Send a plain-text email.
   *
   * @param opts.from - value for the `From` header (e.g. the impersonated
   *   account). Only takes effect when the authenticated identity is allowed to
   *   send as that address (it is when we auth AS that account via OAuth or DWD).
   * @param opts.replyToMessageId - reply to this message: pulls its
   *   Message-ID / References / Subject / threadId so the send sets
   *   In-Reply-To + References and stays in the original thread.
   * @param opts.threadId - explicit Gmail threadId to attach to (overrides the
   *   one derived from replyToMessageId).
   */
  async send(
    to: string,
    subject: string,
    body: string,
    opts?: { from?: string; replyToMessageId?: string; threadId?: string } & RichContent,
  ): Promise<{ id: string; threadId?: string; uuid: string; attachments: AttachmentReportItem[]; body: ComposeReport }> {
    let threadId = opts?.threadId;
    let finalSubject = subject;
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (opts?.replyToMessageId) {
      const { headers, threadId: srcThread } = await this.getMessageHeaders(opts.replyToMessageId);
      if (!threadId) threadId = srcThread;
      const messageIdHeader = headers["message-id"] ?? "";
      inReplyTo = messageIdHeader || undefined;
      references = [headers["references"], messageIdHeader].filter(Boolean).join(" ").trim() || undefined;
      // Preserve the original subject with a single "Re:" prefix when the caller
      // didn't override it (an empty subject means "use the thread's subject").
      if (!subject.trim()) {
        const orig = headers["subject"] ?? "";
        finalSubject = /^re:/i.test(orig.trim()) ? orig : `Re: ${orig}`;
      }
    }

    const uuid = opts?.uuid ?? newEmailUuid();
    const { raw, attachmentReport, bodyReport, bodyRawBytes } = await buildOutgoingRaw(this.env, this.sub, {
      to,
      from: await this.fromHeader(opts?.from),
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject: finalSubject,
      inReplyTo,
      references,
      text: body,
      html: opts?.html,
      markdown: opts?.markdown,
      uuid,
      prebuilt: opts?.prebuilt,
      ...attachmentOpts(opts),
    });

    // Pre-flight size check + JSON-or-upload transport: large messages go to
    // /upload/gmail/v1; an oversized message/body throws before any network call.
    const sent = await sendRawMessage(this.env, this.sub, { raw, bodyRawBytes, threadId });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "send", subject: finalSubject, to, cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, threadId: sent.threadId ?? threadId, messageId: sent.id, sub: this.sub,
    });
    return { ...sent, uuid, attachments: attachmentReport, body: bodyReport };
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    opts?: RichContent,
  ): Promise<{ id: string; message?: { id: string }; uuid: string; attachments: AttachmentReportItem[]; body: ComposeReport }> {
    const uuid = opts?.uuid ?? newEmailUuid();
    const { raw, attachmentReport, bodyReport, bodyRawBytes } = await buildOutgoingRaw(this.env, this.sub, {
      to,
      from: await this.fromHeader(),
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject,
      text: body,
      html: opts?.html,
      markdown: opts?.markdown,
      uuid,
      prebuilt: opts?.prebuilt,
      ...attachmentOpts(opts),
    });
    // Pre-flight size check + JSON-or-upload transport (see sendRawMessage).
    const draft = await createRawDraft(this.env, this.sub, { raw, bodyRawBytes });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "draft", subject, to, cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, messageId: draft.id, sub: this.sub,
    });
    return { ...draft, uuid, attachments: attachmentReport, body: bodyReport };
  }

  /**
   * Read a draft back `format=full` and parse it into {@link GmailDraftView}.
   * Native Gmail draft tooling is create-only; this is the read half of the
   * edit-an-existing-draft path. The `uuid` is parsed from the HTML part's
   * hidden `ref:<uuid>` marker with the same regex `compose.ts` uses — never
   * minted here.
   */
  async getDraft(draftId: string): Promise<GmailDraftView> {
    const draft = await googleJson<{ id?: string; message?: Record<string, unknown> }>(
      this.env,
      this.sub,
      `${BASE}/drafts/${draftId}?format=full`,
    );
    const message = (draft.message ?? {}) as {
      id?: string;
      threadId?: string;
      payload?: { headers?: { name?: string; value?: string }[] };
    };
    const payload = message.payload ?? {};
    const headers = headerMap(payload.headers ?? []);
    const { body: html } = extractBody(payload, "html");
    const { body: text } = extractBody(payload, "text");

    // `uuid` is the message's own hidden ref marker; `refCount` flags duplication.
    const refs = [...html.matchAll(/ref:([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());

    const attachments: DraftAttachmentView[] = extractAttachmentParts(payload).map((p) => ({
      attachmentId: p.attachmentId,
      filename: p.filename,
      mimeType: p.mimeType,
      size: p.size,
      disposition: p.inline ? "inline" : "attachment",
      ...(p.contentId ? { contentId: p.contentId } : {}),
    }));

    return {
      draftId: String(draft.id ?? ""),
      messageId: String(message.id ?? ""),
      threadId: String(message.threadId ?? ""),
      headers: {
        from: headers["from"] ?? "",
        to: splitAddresses(headers["to"] ?? ""),
        cc: splitAddresses(headers["cc"] ?? ""),
        bcc: splitAddresses(headers["bcc"] ?? ""),
        subject: headers["subject"] ?? "",
        ...(headers["in-reply-to"] ? { inReplyTo: headers["in-reply-to"] } : {}),
        ...(headers["references"] ? { references: headers["references"] } : {}),
      },
      uuid: refs[0] ?? null,
      refCount: refs.length,
      html,
      text,
      attachments,
    };
  }

  /**
   * Non-destructively edit an existing draft. Gmail has no partial update —
   * `PUT users/me/drafts/{id}` replaces the whole message — so this is
   * get → merge → rebuild → put:
   *
   *   - `threadId`, `In-Reply-To` and `References` are COPIED from the draft,
   *     never recomputed, so the draft stays in its thread.
   *   - The body ALWAYS round-trips through `composeBody` (via
   *     {@link buildOutgoingRaw}); the draft's existing `uuid` is reused so the
   *     message keeps exactly one hidden ref marker. Never a raw string replace.
   *   - Existing attachments are retained by default — bytes re-fetched and
   *     re-attached, inline images re-embedded under the SAME `cid:` — unless
   *     named in `removeAttachments`.
   *   - `cc`/`bcc`/`subject` replace; `addCc`/`addBcc` append (the CC-add bug).
   *
   * Consumer (`@gmail.com`) accounts are OAuth-only and never DWD; that is the
   * `sub`/`as_user` seam the caller already resolved, so no special-casing here.
   */
  async updateDraft(
    draftId: string,
    edits: DraftUpdateInput,
  ): Promise<{ draftId: string; messageId: string; threadId: string; uuid: string; attachments: AttachmentReportItem[]; body: ComposeReport }> {
    const view = await this.getDraft(draftId);

    // Headers: replace when supplied, else keep the draft's; then append adds.
    const to = edits.to !== undefined ? edits.to : view.headers.to.join(", ");
    let cc = edits.cc !== undefined ? edits.cc : view.headers.cc.join(", ");
    let bcc = edits.bcc !== undefined ? edits.bcc : view.headers.bcc.join(", ");
    if (edits.addCc?.length) cc = mergeAddresses(cc, edits.addCc);
    if (edits.addBcc?.length) bcc = mergeAddresses(bcc, edits.addBcc);
    const subject = edits.subject !== undefined ? edits.subject : view.headers.subject;

    // One id for the life of the draft: reuse its marker, mint only if it has none.
    const uuid = view.uuid ?? newEmailUuid();

    const bodyInput = mergeDraftBody(view.html, edits.body?.mode ?? "replace", {
      markdown: edits.body?.markdown,
      html: edits.body?.html,
      text: edits.body?.text,
    });

    // Retain the draft's attachments (bytes re-fetched), minus any removed, then
    // add the caller's new ones. Inline images keep their Content-ID so the
    // body's `cid:` references still resolve.
    const removals = new Set((edits.removeAttachments ?? []).map((s) => s.toLowerCase()));
    const retained: AttachmentSpec[] = [];
    for (const att of view.attachments) {
      if (!att.attachmentId) continue;
      if (removals.has(att.filename.toLowerCase())) continue;
      if (att.contentId && removals.has(att.contentId.toLowerCase())) continue;
      const { data } = await this.getAttachment(view.messageId, att.attachmentId);
      const filename = att.filename || "attachment";
      if (att.disposition === "inline" && att.contentId) {
        retained.push({ blob: data, filename, mimeType: att.mimeType, as: "inline", contentId: att.contentId });
      } else {
        retained.push({ blob: data, filename, mimeType: att.mimeType });
      }
    }
    const attachments = [...retained, ...(edits.attachments ?? [])];

    const { raw, attachmentReport, bodyReport } = await buildOutgoingRaw(this.env, this.sub, {
      to,
      from: view.headers.from || (await this.fromHeader()),
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject,
      inReplyTo: view.headers.inReplyTo,
      references: view.headers.references,
      text: bodyInput.text,
      html: bodyInput.html,
      markdown: bodyInput.markdown,
      uuid,
      attachments,
    });

    const message: { raw: string; threadId?: string } = { raw };
    if (view.threadId) message.threadId = view.threadId;
    const updated = await googleJson<{ id?: string; message?: { id?: string; threadId?: string } }>(
      this.env,
      this.sub,
      `${BASE}/drafts/${draftId}`,
      { method: "PUT", body: JSON.stringify({ message }) },
    );

    const messageId = updated.message?.id ?? view.messageId;
    const threadId = updated.message?.threadId ?? view.threadId;
    // Upsert, not insert: email_records.uuid is unique and recordEmail swallows
    // the conflict, which would keep the pre-edit recipients. See tracking.ts.
    await upsertEmailRecord(this.env, {
      uuid,
      account: this.sub,
      action: "draft",
      subject,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      body: bodyInput.markdown ?? bodyInput.html ?? bodyInput.text,
      threadId,
      messageId,
      sub: this.sub,
    });

    return { draftId: String(updated.id ?? draftId), messageId, threadId, uuid, attachments: attachmentReport, body: bodyReport };
  }

  /** Send an existing draft by id (used by the scheduled-send sweep). */
  async sendDraft(draftId: string): Promise<{ id: string; threadId?: string }> {
    return googleJson<{ id: string; threadId?: string }>(this.env, this.sub, `${BASE}/drafts/send`, {
      method: "POST",
      body: JSON.stringify({ id: draftId }),
    });
  }

  async getProfile(): Promise<{ emailAddress: string }> {
    return googleJson<{ emailAddress: string }>(this.env, this.sub, `${BASE}/profile`);
  }

  async getMessageHeaders(messageId: string): Promise<{ headers: Record<string, string>; threadId: string }> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "To", "Cc", "Subject", "Message-ID", "References"]) {
      params.append("metadataHeaders", name);
    }
    const out = await googleJson<{ threadId: string; payload?: { headers?: { name: string; value: string }[] } }>(
      this.env,
      this.sub,
      `${BASE}/messages/${messageId}?${params}`,
    );
    const headers: Record<string, string> = {};
    for (const h of out.payload?.headers ?? []) {
      headers[h.name.toLowerCase()] = h.value;
    }
    return { headers, threadId: out.threadId };
  }

  async createReplyDraft(
    messageId: string,
    body: string,
    opts?: { to?: string[]; replyAll?: boolean } & RichContent,
  ): Promise<{ id: string; message?: { id: string; threadId?: string }; uuid: string; attachments: AttachmentReportItem[]; body: ComposeReport }> {
    const [{ headers, threadId }, profile] = await Promise.all([this.getMessageHeaders(messageId), this.getProfile()]);
    const self = profile.emailAddress.toLowerCase();

    let recipients: string[];
    if (opts?.to && opts.to.length > 0) {
      recipients = opts.to;
    } else if (opts?.replyAll === false) {
      recipients = extractEmails(headers["from"]);
    } else {
      const seen = new Set<string>();
      recipients = [];
      for (const addr of [...extractEmails(headers["from"]), ...extractEmails(headers["to"]), ...extractEmails(headers["cc"])]) {
        const key = addr.toLowerCase();
        if (key === self || seen.has(key)) continue;
        seen.add(key);
        recipients.push(addr);
      }
    }

    const originalSubject = headers["subject"] ?? "";
    const subject = /^re:/i.test(originalSubject.trim()) ? originalSubject : `Re: ${originalSubject}`;
    const messageIdHeader = headers["message-id"] ?? "";
    const references = [headers["references"], messageIdHeader].filter(Boolean).join(" ").trim();

    const uuid = opts?.uuid ?? newEmailUuid();
    const { raw, attachmentReport, bodyReport, bodyRawBytes } = await buildOutgoingRaw(this.env, this.sub, {
      to: recipients.join(", "),
      from: await this.fromHeader(profile.emailAddress),
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject,
      inReplyTo: messageIdHeader || undefined,
      references: references || undefined,
      text: body,
      html: opts?.html,
      markdown: opts?.markdown,
      uuid,
      prebuilt: opts?.prebuilt,
      ...attachmentOpts(opts),
    });

    // Pre-flight size check + JSON-or-upload transport (see sendRawMessage).
    const draft = await createRawDraft(this.env, this.sub, { raw, bodyRawBytes, threadId });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "reply_draft", subject, to: recipients.join(", "), cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, threadId, messageId: draft.id, sub: this.sub,
    });
    return { ...draft, uuid, attachments: attachmentReport, body: bodyReport };
  }

  async listLabels(): Promise<{ labels: unknown[] }> {
    const out = await googleJson<{ labels?: unknown[] }>(this.env, this.sub, `${BASE}/labels`);
    return { labels: out.labels ?? [] };
  }

  async createLabel(name: string): Promise<{ id: string; name: string }> {
    return googleJson<{ id: string; name: string }>(this.env, this.sub, `${BASE}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
  }

  /** Create a Gmail filter that auto-applies `labelId` to matching messages. */
  async createFilter(
    criteria: Record<string, unknown>,
    labelId: string,
  ): Promise<{ id: string; criteria: Record<string, unknown> }> {
    return googleJson<{ id: string; criteria: Record<string, unknown> }>(
      this.env,
      this.sub,
      `${BASE}/settings/filters`,
      { method: "POST", body: JSON.stringify({ criteria, action: { addLabelIds: [labelId] } }) },
    );
  }

  async modifyMessageLabels(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<GmailMessage> {
    return googleJson<GmailMessage>(this.env, this.sub, `${BASE}/messages/${id}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  async getThread(threadId: string): Promise<{ id: string; messages: GmailMessage[] }> {
    return googleJson(this.env, this.sub, `${BASE}/threads/${threadId}?format=full`);
  }

  async trashMessage(id: string): Promise<GmailMessage> {
    return googleJson<GmailMessage>(this.env, this.sub, `${BASE}/messages/${id}/trash`, { method: "POST" });
  }
}
