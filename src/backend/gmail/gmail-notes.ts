/**
 * @file gmail/gmail-notes.ts
 * @description Agent notes on a Gmail thread, message or attachment, in `gws.notes`.
 * The point: once an agent has worked out what a message means ("she never said IP
 * Roofing would provide the COI, Mr. Roofing will"), it writes that down once and every
 * later read of the thread shows it, so the same conversation is not repeated.
 *
 * A note's parents are integer FKs, so adding one to something we have not stored yet
 * syncs the thread first. The tools speak Gmail ids for threads/messages and the integer
 * `attachments[].id` for attachments. Everything is scoped to the mailbox.
 */
import type { GmailService } from "@/backend/mcp/services/gmail";

import { accountId, noteView, syncThreadWith, withSql, type NoteView, type Sql } from "./thread-index";

export const MAX_NOTE_CHARS = 20_000;

export interface NoteTarget {
  /** Gmail thread id. */
  threadId?: string;
  /** Gmail message id. */
  messageId?: string;
  /** gws.gmail_attachments.id. */
  attachmentId?: number;
}

export interface NoteCtx {
  env: Env;
  gmail: GmailService;
  /** Mailbox email, lower-case. */
  email: string;
  /** Acting identity, stored as the note's author. */
  author: string;
}

interface Resolved {
  accountPk: number;
  threadPk: number;
  messagePk: number | null;
  attachmentPk: number | null;
}

const NOTE_SELECT = (sql: Sql) => sql`
  select n.id, t.gmail_thread_id, m.gmail_message_id, n.attachment_id, n.body, n.author, n.created_at, n.updated_at
  from gws.notes n
  join gws.gmail_threads t on t.id = n.thread_id
  left join gws.gmail_messages m on m.id = n.message_id`;

/**
 * Work out thread / message / attachment keys from whatever the caller named, and
 * check they agree. Syncs the thread when we have not stored it yet.
 */
async function resolveTarget(sql: Sql, ctx: NoteCtx, t: NoteTarget): Promise<Resolved> {
  if (!t.threadId && !t.messageId && !t.attachmentId) throw new Error("name a threadId, messageId or attachmentId");
  const accId = await accountId(sql, ctx.email);

  let messagePk: number | null = null;
  let attachmentPk: number | null = null;
  let threadPk: number | null = null;

  if (t.attachmentId) {
    const att = (
      await sql<{ id: number; message_id: number; gmail_message_id: string; thread_id: number }[]>`
        select a.id, a.message_id, m.gmail_message_id, m.thread_id
        from gws.gmail_attachments a join gws.gmail_messages m on m.id = a.message_id
        where a.id = ${t.attachmentId} and m.account_id = ${accId}`
    )[0];
    if (!att) throw new Error(`unknown attachmentId ${t.attachmentId}: take it from attachments[].id in gmail_get_thread or gmail_get_message`);
    if (t.messageId && t.messageId !== att.gmail_message_id) {
      throw new Error(`attachment ${t.attachmentId} belongs to message ${att.gmail_message_id}, not ${t.messageId}`);
    }
    attachmentPk = att.id;
    messagePk = att.message_id;
    threadPk = att.thread_id;
  }

  if (t.messageId && messagePk == null) {
    const find = async () =>
      (
        await sql<{ id: number; thread_id: number; gmail_thread_id: string }[]>`
          select id, thread_id, gmail_thread_id from gws.gmail_messages
          where account_id = ${accId} and gmail_message_id = ${t.messageId as string}`
      )[0];
    let msg = await find();
    if (!msg) {
      // Not stored yet: learn its thread from Gmail, sync that thread, look again.
      const head = await ctx.gmail.getMessageHeaders(t.messageId);
      await syncThreadWith(sql, ctx.gmail, ctx.email, head.threadId);
      msg = await find();
      if (!msg) throw new Error(`message ${t.messageId} could not be stored (a draft, or the fetch failed): call gmail_thread_sync on its thread and read index.fetchErrors`);
    }
    if (t.threadId && t.threadId !== msg.gmail_thread_id) throw new Error(`message ${t.messageId} is on thread ${msg.gmail_thread_id}, not ${t.threadId}`);
    messagePk = msg.id;
    threadPk = msg.thread_id;
  }

  if (threadPk == null && t.threadId) {
    const have = (
      await sql<{ id: number }[]>`select id from gws.gmail_threads where account_id = ${accId} and gmail_thread_id = ${t.threadId}`
    )[0];
    threadPk = have ? have.id : (await syncThreadWith(sql, ctx.gmail, ctx.email, t.threadId)).threadPk;
  }
  return { accountPk: accId, threadPk: threadPk as number, messagePk, attachmentPk };
}

/** Add one note. Any target can hold any number of notes. */
export async function addNote(ctx: NoteCtx, t: NoteTarget & { note: string }): Promise<NoteView> {
  const note = t.note.trim();
  if (!note) throw new Error("note is empty");
  if (note.length > MAX_NOTE_CHARS) throw new Error(`note is ${note.length} characters; the limit is ${MAX_NOTE_CHARS}`);
  return withSql(ctx.env, async (sql) => {
    const r = await resolveTarget(sql, ctx, t);
    const ins = await sql<{ id: number }[]>`
      insert into gws.notes (thread_id, message_id, attachment_id, body, author)
      values (${r.threadPk}, ${r.messagePk}, ${r.attachmentPk}, ${note}, ${ctx.author})
      returning id`;
    const rows = await sql<Parameters<typeof noteView>[0][]>`${NOTE_SELECT(sql)} where n.id = ${ins[0].id}`;
    return noteView(rows[0]);
  });
}

/**
 * List notes. `threadId` returns every note in the thread (thread, message and
 * attachment level). `messageId` returns that message's notes plus its attachments'.
 * `query` keeps notes containing the text, case-insensitive.
 */
export async function listNotes(
  env: Env,
  email: string,
  f: NoteTarget & { query?: string; limit?: number },
): Promise<NoteView[]> {
  return withSql(env, async (sql) => {
    const accId = await accountId(sql, email);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const asc = Boolean(f.threadId || f.messageId);
    const rows = await sql<Parameters<typeof noteView>[0][]>`
      ${NOTE_SELECT(sql)}
      where t.account_id = ${accId}
        ${f.threadId ? sql`and t.gmail_thread_id = ${f.threadId}` : sql``}
        ${f.messageId ? sql`and m.gmail_message_id = ${f.messageId}` : sql``}
        ${f.attachmentId ? sql`and n.attachment_id = ${f.attachmentId}` : sql``}
        ${f.query?.trim() ? sql`and n.body ilike ${"%" + f.query.trim().replace(/[\\%_]/g, "\\$&") + "%"}` : sql``}
      order by ${asc ? sql`n.created_at asc, n.id asc` : sql`n.created_at desc, n.id desc`}
      limit ${limit}`;
    return rows.map(noteView);
  });
}

/** Replace a note's text. Returns null when no such note exists in this mailbox. */
export async function updateNote(env: Env, email: string, id: number, text: string): Promise<NoteView | null> {
  const note = text.trim();
  if (!note) throw new Error("note is empty");
  if (note.length > MAX_NOTE_CHARS) throw new Error(`note is ${note.length} characters; the limit is ${MAX_NOTE_CHARS}`);
  return withSql(env, async (sql) => {
    const accId = await accountId(sql, email);
    const upd = await sql<{ id: number }[]>`
      update gws.notes n set body = ${note}, updated_at = now()
      from gws.gmail_threads t
      where n.id = ${id} and t.id = n.thread_id and t.account_id = ${accId}
      returning n.id`;
    if (!upd.length) return null;
    const rows = await sql<Parameters<typeof noteView>[0][]>`${NOTE_SELECT(sql)} where n.id = ${id}`;
    return rows[0] ? noteView(rows[0]) : null;
  });
}

/** Delete a note. Returns whether one was removed. */
export async function deleteNote(env: Env, email: string, id: number): Promise<boolean> {
  return withSql(env, async (sql) => {
    const accId = await accountId(sql, email);
    const del = await sql<{ id: number }[]>`
      delete from gws.notes n using gws.gmail_threads t
      where n.id = ${id} and t.id = n.thread_id and t.account_id = ${accId}
      returning n.id`;
    return del.length > 0;
  });
}
