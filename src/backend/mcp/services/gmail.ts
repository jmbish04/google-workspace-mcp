import { googleJson } from "../googleClient";
import { buildOutgoingRaw } from "@/backend/gmail/build-outgoing";
import { newEmailUuid, embedUuid, recordEmail } from "@/backend/gmail/tracking";
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
  /** Unified attachment specs: Drive files, inline blobs, or forced links. */
  attachments?: AttachmentSpec[];
  /** Legacy: Drive file ids to attach (auto-fallback to shared links over the size cap). */
  driveIds?: string[];
  /** Legacy: inline base64 blobs to attach (auto-fallback to shared links over the size cap). */
  blobs?: BlobInput[];
}

/** Pass the caller's attachment inputs through to the MIME builder. */
function attachmentOpts(opts?: RichContent): Pick<RichContent, "attachments" | "driveIds" | "blobs"> {
  return { attachments: opts?.attachments, driveIds: opts?.driveIds, blobs: opts?.blobs };
}

export type { AttachmentReportItem };

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

export class GmailService {
  constructor(private env: Env, private sub: string) {}

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
  ): Promise<{ id: string; threadId?: string; attachments: AttachmentReportItem[] }> {
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

    const uuid = newEmailUuid();
    const b = embedUuid({ text: body, html: opts?.html, markdown: opts?.markdown }, uuid);
    const { raw, attachmentReport } = await buildOutgoingRaw(this.env, this.sub, {
      to,
      from: opts?.from,
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject: finalSubject,
      inReplyTo,
      references,
      text: b.text ?? "",
      html: b.html,
      markdown: b.markdown,
      ...attachmentOpts(opts),
    });

    const payload: { raw: string; threadId?: string } = { raw };
    if (threadId) payload.threadId = threadId;
    const sent = await googleJson<{ id: string; threadId?: string }>(this.env, this.sub, `${BASE}/messages/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "send", subject: finalSubject, to, cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, threadId: sent.threadId ?? threadId, messageId: sent.id, sub: this.sub,
    });
    return { ...sent, attachments: attachmentReport };
  }

  async createDraft(
    to: string,
    subject: string,
    body: string,
    opts?: RichContent,
  ): Promise<{ id: string; message?: { id: string }; attachments: AttachmentReportItem[] }> {
    const uuid = newEmailUuid();
    const b = embedUuid({ text: body, html: opts?.html, markdown: opts?.markdown }, uuid);
    const { raw, attachmentReport } = await buildOutgoingRaw(this.env, this.sub, {
      to,
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject,
      text: b.text ?? "",
      html: b.html,
      markdown: b.markdown,
      ...attachmentOpts(opts),
    });
    const draft = await googleJson<{ id: string; message?: { id: string } }>(this.env, this.sub, `${BASE}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "draft", subject, to, cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, messageId: draft.id, sub: this.sub,
    });
    return { ...draft, attachments: attachmentReport };
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
  ): Promise<{ id: string; message?: { id: string; threadId?: string }; attachments: AttachmentReportItem[] }> {
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

    const uuid = newEmailUuid();
    const b = embedUuid({ text: body, html: opts?.html, markdown: opts?.markdown }, uuid);
    const { raw, attachmentReport } = await buildOutgoingRaw(this.env, this.sub, {
      to: recipients.join(", "),
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject,
      inReplyTo: messageIdHeader || undefined,
      references: references || undefined,
      text: b.text ?? "",
      html: b.html,
      markdown: b.markdown,
      ...attachmentOpts(opts),
    });

    const draft = await googleJson<{ id: string; message?: { id: string; threadId?: string } }>(this.env, this.sub, `${BASE}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw, threadId } }),
    });
    await recordEmail(this.env, {
      uuid, account: this.sub, action: "reply_draft", subject, to: recipients.join(", "), cc: opts?.cc, bcc: opts?.bcc,
      body: opts?.markdown ?? opts?.html ?? body, threadId, messageId: draft.id, sub: this.sub,
    });
    return { ...draft, attachments: attachmentReport };
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
