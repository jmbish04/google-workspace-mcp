/**
 * Integration test for the Postgres thread cache + notes. Runs only when GWS_TEST_PG_DSN
 * points at a database that has the `gws` schema (the LXC 109 Postgres, over the LAN):
 *   GWS_TEST_PG_DSN=postgres://... pnpm vitest run thread-index.pg
 * Every row it writes belongs to a throwaway mailbox that the afterAll hook deletes.
 */
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";

const DSN = process.env.GWS_TEST_PG_DSN;

vi.mock("@/backend/db/postgres", () => ({
  getSql: () => postgres(DSN as string, { max: 2, fetch_types: false }),
}));

import { addNote, deleteNote, listNotes, updateNote } from "../gmail-notes";
import { getMessageIndexed, getThreadIndexed, syncThread } from "../thread-index";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const EMAIL = `pgtest-${Date.now()}@mailbox.test`;

function raw(id: string, ms: number, o: { labels?: string[]; body?: string; attach?: boolean } = {}) {
  return {
    id,
    threadId: "T1",
    labelIds: o.labels ?? ["INBOX"],
    snippet: `snippet ${id}`,
    internalDate: String(ms),
    payload: {
      mimeType: o.attach ? "multipart/mixed" : "text/plain",
      headers: [
        { name: "From", value: "Eloisa Perez <eloisa@iproofing.test>" },
        { name: "To", value: "Owner <owner@mailbox.test>" },
        { name: "Subject", value: "COI for the roof" },
        { name: "Message-ID", value: `<${id}@mail.test>` },
      ],
      ...(o.attach
        ? {
            parts: [
              { partId: "0", mimeType: "text/plain", body: { data: b64(o.body ?? "see attached") } },
              { partId: "1", filename: "coi.pdf", mimeType: "application/pdf", body: { attachmentId: `att-${id}`, size: 1234 } },
            ],
          }
        : { body: { data: b64(o.body ?? `body of ${id}`) } }),
    },
  };
}

function fakeGmail(messages: Record<string, ReturnType<typeof raw>>) {
  return {
    getThreadMeta: async () => ({
      id: "T1",
      historyId: "h1",
      messages: Object.values(messages).map((m) => ({ id: m.id, labelIds: m.labelIds, internalDate: m.internalDate })),
    }),
    getRawMessage: vi.fn(async (id: string) => messages[id]),
    getMessageHeaders: async (id: string) => ({ threadId: messages[id].threadId }),
    getMessageRfc: async () => "",
  } as never;
}

const run = DSN ? describe : describe.skip;

run("postgres thread cache + notes", () => {
  const msgs: Record<string, ReturnType<typeof raw>> = {
    m1: raw("m1", 1000),
    m2: raw("m2", 2000, { attach: true }),
    m3: raw("m3", 3000, { labels: ["DRAFT"] }),
  };
  const gmail = fakeGmail(msgs);
  const rawCalls = () => (gmail as unknown as { getRawMessage: ReturnType<typeof vi.fn> }).getRawMessage;
  const ctx = { gmail, ref: "x", accountKey: "x", email: EMAIL };
  const env = {} as Env;
  const sql = () => postgres(DSN as string, { max: 1, fetch_types: false });

  afterAll(async () => {
    const s = sql();
    const acc = (await s`select id from gws.accounts where email = ${EMAIL}`)[0];
    if (acc) {
      await s`delete from gws.gmail_threads where account_id = ${acc.id}`;
      await s`delete from gws.accounts where id = ${acc.id}`;
    }
    await s`delete from gws.people where email in ('eloisa@iproofing.test', 'owner@mailbox.test')`;
    await s.end();
  });

  it("indexes a thread, reports 3 of 3 with the draft read live, and stores people + roles", async () => {
    const r = await getThreadIndexed(env, ctx, { threadId: "T1", includeAttachments: false });
    expect(r.index).toMatchObject({ gmailCount: 3, indexedCount: 2, drafts: 1, newlyIndexed: 2, pending: 0, complete: true });
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(r.messages[2].draft).toBe(true);
    expect(r.messages[0].labelIds).toEqual(["INBOX"]); // text[] columns come back as arrays
    expect(r.messages[0].internalDate).toBe(1000);
    const s = sql();
    const roles = await s`select p.email::text as email, mp.role::text as role from gws.message_participants mp
      join gws.people p on p.id = mp.person_id join gws.gmail_messages m on m.id = mp.message_id
      join gws.accounts a on a.id = m.account_id where a.email = ${EMAIL} and m.gmail_message_id = 'm1' order by role`;
    await s.end();
    expect(roles.map((x) => ({ ...x }))).toEqual([
      { email: "eloisa@iproofing.test", role: "from" },
      { email: "owner@mailbox.test", role: "to" },
    ]);
  });

  it("second pull fetches nothing; a new reply fetches exactly one; a vanished message is marked gone", async () => {
    rawCalls().mockClear();
    const again = await syncThread(env, gmail, EMAIL, "T1");
    expect(again.status.newlyIndexed).toBe(0);
    expect(rawCalls().mock.calls.map((c: unknown[]) => c[0])).toEqual(["m3"]); // only the draft, read live
    msgs.m4 = raw("m4", 4000);
    const next = await syncThread(env, gmail, EMAIL, "T1");
    expect(next.status.newlyIndexed).toBe(1);
    expect(next.status.indexedCount).toBe(3);
    delete msgs.m4;
    const gone = await syncThread(env, gmail, EMAIL, "T1");
    expect(gone.status.indexedCount).toBe(2);
    const s = sql();
    const [g] = await s`select count(*)::int as n from gws.gmail_messages m join gws.accounts a on a.id = m.account_id
      where a.email = ${EMAIL} and m.gmail_message_id = 'm4' and m.gone_at is not null`;
    await s.end();
    expect(g.n).toBe(1);
  });

  it("serves a stored message with no Gmail fetch and registers its attachment", async () => {
    rawCalls().mockClear();
    const m = await getMessageIndexed(env, ctx, { id: "m2", format: "text", includeAttachmentText: false });
    expect(m.cached).toBe(true);
    expect(rawCalls()).not.toHaveBeenCalled();
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: "coi.pdf", status: "pending" });
    expect(m.contacts.map((c) => c.type).sort()).toEqual(["from", "to"]);
  });

  it("notes: thread, message and attachment levels, many per target, update, delete", async () => {
    const t = await getThreadIndexed(env, ctx, { threadId: "T1", includeAttachments: false });
    const attId = t.messages[1].attachments[0].id as number;
    const nctx = { env, gmail, email: EMAIL, author: "tester" };
    const n1 = await addNote(nctx, { threadId: "T1", note: "thread-level conclusion" });
    const n2 = await addNote(nctx, { messageId: "m1", note: "she never promised the COI" });
    const n3 = await addNote(nctx, { messageId: "m1", note: "second note, same message" });
    const n4 = await addNote(nctx, { attachmentId: attId, note: "COI lists wrong insured" });
    expect([n1.scope, n2.scope, n4.scope]).toEqual(["thread", "message", "attachment"]);
    expect(n4.messageId).toBe("m2");

    const view = await getThreadIndexed(env, ctx, { threadId: "T1", includeAttachments: false });
    expect(view.notes.map((n) => n.id)).toEqual([n1.id]);
    expect(view.messages[0].notes.map((n) => n.id)).toEqual([n2.id, n3.id]);
    expect(view.messages[1].attachments[0].notes.map((n) => n.id)).toEqual([n4.id]);

    expect((await listNotes(env, EMAIL, { threadId: "T1" })).length).toBe(4);
    expect((await listNotes(env, EMAIL, { query: "WRONG INSURED" })).map((n) => n.id)).toEqual([n4.id]);
    expect((await updateNote(env, EMAIL, n1.id, "edited"))?.note).toBe("edited");
    expect(await deleteNote(env, EMAIL, n3.id)).toBe(true);
    expect(await deleteNote(env, EMAIL, n3.id)).toBe(false);
    expect(await updateNote(env, "other@mailbox.test", n1.id, "x")).toBeNull(); // another mailbox cannot touch it
  });

  it("rejects mismatched targets and blank notes", async () => {
    const c = { env, gmail, email: EMAIL, author: "t" };
    await expect(addNote(c, { threadId: "T1", note: "   " })).rejects.toThrow("empty");
    await expect(addNote(c, { messageId: "m1", threadId: "OTHER", note: "x" })).rejects.toThrow("not OTHER");
    await expect(addNote(c, { attachmentId: 999999999, note: "x" })).rejects.toThrow("unknown attachmentId");
    await expect(addNote(c, { note: "x" })).rejects.toThrow("name a threadId");
  });
});
