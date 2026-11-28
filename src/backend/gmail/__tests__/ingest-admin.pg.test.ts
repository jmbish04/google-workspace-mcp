/**
 * Integration test for rules / projects / tasks / search against the real Postgres.
 * Runs only with GWS_TEST_PG_DSN (see thread-index.pg.test.ts). Guardian is stubbed with a
 * deterministic embedding so the ranking is checkable; every row is removed afterwards.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DSN = process.env.GWS_TEST_PG_DSN;

vi.mock("@/backend/db/postgres", () => ({
  getSql: () => postgres(DSN as string, { max: 2, fetch_types: false }),
}));
vi.mock("@/backend/utils/secrets", () => ({ getSecret: async () => "test-token" }));

import { addTask, deleteRule, getProject, ingestStatus, linkProject, listProjects, listRules, searchMail, updateTask, upsertProject, upsertRule, vecLiteral } from "../ingest-admin";

const KEY = "pgtest-roofing";
const EMAIL = `ingest-${Date.now()}@mailbox.test`;
const unit = (i: number) => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));

const run = DSN ? describe : describe.skip;

run("ingest admin on postgres", () => {
  const sql = () => postgres(DSN as string, { max: 1, fetch_types: false });
  let insured = 0;
  let lunch = 0;

  beforeAll(() => {
    // Guardian stub: "insurance" -> axis 0, everything else -> axis 1.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const text = JSON.parse(init.body).input[0] as string;
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: unit(/insur/i.test(text) ? 0 : 1) }] }), { status: 200 });
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    const s = sql();
    await s`delete from gws.ingest_rules where name like 'pgtest-%'`;
    await s`delete from app.projects where key = ${KEY}`;
    const acc = (await s`select id from gws.accounts where email = ${EMAIL}`)[0];
    if (acc) {
      await s`delete from gws.gmail_threads where account_id = ${acc.id}`;
      await s`delete from gws.accounts where id = ${acc.id}`;
    }
    await s`delete from gws.people where email = 'contractor@iproofing.test'`;
    await s.end();
  });

  it("rules: refuses empty conditions, creates, versions on update, lists with project key, deletes", async () => {
    await expect(upsertRule({} as Env, { name: "pgtest-empty", target: "gmail", conditions: {}, actions: {} })).rejects.toThrow("at least one condition");
    await expect(upsertRule({} as Env, { name: "pgtest-x", target: "gmail", projectKey: "nope", conditions: { from: ["a"] }, actions: {} })).rejects.toThrow("unknown project key");
    await upsertProject({} as Env, { key: KEY, name: "Mr. Roofing", background: "Roof replacement dispute", context: { amount: 41500 } });
    const created = await upsertRule({} as Env, { name: "pgtest-rule", target: "gmail", projectKey: KEY, conditions: { from: ["iproofing.test"] }, actions: { embed: true } });
    expect(created.version).toBe(1);
    const updated = await upsertRule({} as Env, { id: created.id, name: "pgtest-rule", target: "gmail", priority: 5, conditions: { from: ["iproofing.test"] }, actions: { embed: true, extractAttachments: true } });
    expect(updated.version).toBe(2);
    const rules = (await listRules({} as Env)).filter((r) => r.name === "pgtest-rule");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ project_key: KEY, priority: 5, enabled: true });
    expect(await deleteRule({} as Env, created.id)).toBe(true);
    expect(await deleteRule({} as Env, created.id)).toBe(false);
  });

  it("project: background/context kept on partial update; tasks; thread + person links", async () => {
    await upsertProject({} as Env, { key: KEY, name: "Mr. Roofing", status: "on_hold" });
    const s = sql();
    const acc = (await s`insert into gws.accounts (email, kind) values (${EMAIL}, 'workspace') returning id`)[0].id;
    const th = (await s`insert into gws.gmail_threads (account_id, gmail_thread_id, subject) values (${acc}, 'PT1', 'COI') returning id`)[0].id;
    const msg = (
      await s`insert into gws.gmail_messages (thread_id, account_id, gmail_thread_id, gmail_message_id, subject, body_text)
              values (${th}, ${acc}, 'PT1', 'pm1', 'COI', 'certificate of insurance lists the wrong insured') returning id`
    )[0].id;
    const lun = (
      await s`insert into gws.gmail_messages (thread_id, account_id, gmail_thread_id, gmail_message_id, subject, body_text)
              values (${th}, ${acc}, 'PT1', 'pm2', 'Lunch', 'lunch plans for friday') returning id`
    )[0].id;
    insured = (await s`insert into gws.content_chunks (message_id, chunk_index, text, embedding, model) values (${msg}, 0, 'certificate of insurance lists the wrong insured', ${vecLiteral(unit(0))}::vector, 'm') returning id`)[0].id;
    lunch = (await s`insert into gws.content_chunks (message_id, chunk_index, text, embedding, model) values (${lun}, 0, 'lunch plans for friday', ${vecLiteral(unit(1))}::vector, 'm') returning id`)[0].id;
    await s.end();

    const t = await addTask({} as Env, { projectKey: KEY, title: "Get corrected COI", sourceMessageId: "pm1", email: EMAIL });
    expect(t.status).toBe("todo");
    await expect(addTask({} as Env, { projectKey: KEY, title: "x", sourceMessageId: "ghost", email: EMAIL })).rejects.toThrow("not stored");
    expect((await updateTask({} as Env, t.id, { status: "blocked" })).status).toBe("blocked");
    await expect(updateTask({} as Env, 999999999, { status: "done" })).rejects.toThrow("no task");

    expect(await linkProject({} as Env, { projectKey: KEY, threadId: "PT1", personEmail: "contractor@iproofing.test", roleNote: "roofing contractor", email: EMAIL })).toEqual({ thread: true, person: true });
    await expect(linkProject({} as Env, { projectKey: KEY, threadId: "GHOST", email: EMAIL })).rejects.toThrow("not stored");
    await expect(linkProject({} as Env, { projectKey: KEY, email: EMAIL })).rejects.toThrow("name a threadId");

    const p = await getProject({} as Env, KEY);
    expect(p?.project).toMatchObject({ background: "Roof replacement dispute", status: "on_hold" });
    expect((p?.project.context as { amount: number }).amount).toBe(41500);
    expect(p?.tasks.map((x) => x.title)).toEqual(["Get corrected COI"]);
    expect(p?.threads.map((x) => x.gmail_thread_id)).toEqual(["PT1"]);
    expect(p?.people[0]).toMatchObject({ email: "contractor@iproofing.test", role_note: "roofing contractor" });
    expect((await listProjects({} as Env)).find((x) => x.key === KEY)).toMatchObject({ open_tasks: 1, threads: 1 });
  });

  it("search: semantic hit ranks first, project filter scopes results, other project sees nothing", async () => {
    const hits = await searchMail({} as Env, { query: "insurance problem", limit: 5 });
    const mine = hits.filter((h) => [insured, lunch].includes(h.chunkId));
    expect(mine[0].chunkId).toBe(insured);
    expect(mine[0]).toMatchObject({ messageId: "pm1", threadId: "PT1", subject: "COI" });
    const scoped = await searchMail({} as Env, { query: "insurance problem", projectKey: KEY });
    expect(scoped.map((h) => h.chunkId)).toEqual(expect.arrayContaining([insured, lunch]));
    await upsertProject({} as Env, { key: `${KEY}-other`, name: "Other" });
    try {
      expect(await searchMail({} as Env, { query: "insurance problem", projectKey: `${KEY}-other` })).toEqual([]);
    } finally {
      const s = sql();
      await s`delete from app.projects where key = ${`${KEY}-other`}`;
      await s.end();
    }
  });

  it("status counts include what we inserted", async () => {
    const st = await ingestStatus({} as Env);
    expect(st.counts.embedded_chunks).toBeGreaterThanOrEqual(2);
    expect(st.embedModel).toBe("@cf/baai/bge-m3");
  });

  it("search surfaces a Guardian failure instead of returning empty results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(searchMail({} as Env, { query: "anything" })).rejects.toThrow("guardian embeddings 401");
  });
});
