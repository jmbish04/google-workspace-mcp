/**
 * @file gmail/tracking.ts
 * @description Outgoing-email tracking. For every draft/reply/send the worker
 * proxies, we (1) mint a UUID, (2) embed it hidden (white, ~0-height) at the
 * bottom of the body, and (3) log the message metadata to D1 (`email_records`).
 * Later an agent can recall the exact thread by UUID/subject/date instead of
 * re-reading mail, and disambiguate near-duplicate drafts.
 *
 * Best-effort: recording never throws into the send path (a logging failure must
 * not block the actual email).
 */
import { and, desc, eq, gte, like, lte } from "drizzle-orm";

import { getDb } from "@/db";
import { emailRecords, type EmailRecordRow } from "@db/schemas";

/** A fresh tracking id. */
export function newEmailUuid(): string {
  return crypto.randomUUID();
}

/** Hidden (white, collapsed) HTML carrying the tracking id — invisible in clients. */
export function hiddenUuidHtml(uuid: string): string {
  return `<div style="color:#ffffff;font-size:1px;line-height:1px;max-height:0;overflow:hidden;mso-hide:all">ref:${uuid}</div>`;
}

export interface BodyInputs {
  text?: string;
  html?: string;
  markdown?: string;
}

/**
 * Append the hidden tracking marker to whichever body form the caller supplied.
 * HTML/markdown get the invisible white div; a text-only body gets a discreet
 * trailing `ref:` line (plain text can't truly hide, but keeps recall working).
 */
export function embedUuid(body: BodyInputs, uuid: string): BodyInputs {
  const out: BodyInputs = { ...body };
  const marker = hiddenUuidHtml(uuid);
  if (out.markdown != null && out.markdown !== "") out.markdown = `${out.markdown}\n\n${marker}`;
  else if (out.html != null && out.html !== "") out.html = `${out.html}\n${marker}`;
  else out.text = `${out.text ?? ""}\n\nref:${uuid}`;
  return out;
}

export interface EmailRecordInput {
  uuid: string;
  account?: string;
  action: "draft" | "reply_draft" | "send";
  subject?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  body?: string;
  threadId?: string;
  messageId?: string;
  sub?: string;
}

/** Log an outgoing email to D1. Best-effort — swallows errors. */
export async function recordEmail(env: Env, r: EmailRecordInput): Promise<void> {
  try {
    await getDb(env)
      .insert(emailRecords)
      .values({
        uuid: r.uuid,
        account: r.account ?? null,
        action: r.action,
        subject: r.subject ?? null,
        recipients: { to: r.to, cc: r.cc, bcc: r.bcc },
        body: r.body ?? null,
        threadId: r.threadId ?? null,
        messageId: r.messageId ?? null,
        createdBySub: r.sub ?? null,
      });
  } catch {
    /* logging must never break the send */
  }
}

/** Query the outgoing-email log for recall. */
export async function findEmailRecords(
  env: Env,
  q: { uuid?: string; subject?: string; recipient?: string; since?: Date; until?: Date; limit?: number },
): Promise<EmailRecordRow[]> {
  const conds = [];
  if (q.uuid) conds.push(eq(emailRecords.uuid, q.uuid));
  if (q.subject) conds.push(like(emailRecords.subject, `%${q.subject}%`));
  if (q.since) conds.push(gte(emailRecords.createdAt, q.since));
  if (q.until) conds.push(lte(emailRecords.createdAt, q.until));
  let rows = await getDb(env)
    .select()
    .from(emailRecords)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(emailRecords.createdAt))
    .limit(Math.min(q.limit ?? 25, 100));
  // Recipient match spans the JSON blob — filter in JS (small result set).
  if (q.recipient) {
    const needle = q.recipient.toLowerCase();
    rows = rows.filter((r) => JSON.stringify(r.recipients ?? {}).toLowerCase().includes(needle));
  }
  return rows;
}
