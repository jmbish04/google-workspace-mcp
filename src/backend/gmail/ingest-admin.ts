/**
 * @file gmail/ingest-admin.ts
 * @description Worker-side admin for the Postgres mail store: hybrid search over embedded
 * mail and attachment text, routing rules (the "filters" that decide what gets indexed),
 * projects (e.g. "Mr. Roofing": background, context, tasks, linked threads and people) and
 * ingest status. All SQL goes through Hyperdrive (`withSql`); the query embedding goes
 * through Core Guardian (`/v1/embeddings`, bearer = AI_GATEWAY_TOKEN), never a provider.
 */
import { getSecret } from "@/backend/utils/secrets";

import { accountId, pgTextArray, withSql, type Sql } from "./thread-index";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIMS = 1024;
const GUARDIAN = "https://core-guardian.hacolby.workers.dev";

/** Embed one string through Guardian. Throws with the upstream message on any failure. */
export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const token = await getSecret(env, "AI_GATEWAY_TOKEN");
  if (!token) throw new Error("AI_GATEWAY_TOKEN is not bound: cannot embed through Core Guardian");
  // Service binding when present (a workers.dev fetch to a sibling Worker answers 1042).
  const bound = (env as unknown as { GUARDIAN_HTTP?: { fetch: typeof fetch } }).GUARDIAN_HTTP;
  const res = await (bound ? bound.fetch.bind(bound) : fetch)(`${GUARDIAN}/v1/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-guardian-project": "google-workspace-mcp", "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: [text], dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`guardian embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const vec = ((await res.json()) as { data: { embedding: number[] }[] }).data?.[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIMS) throw new Error(`guardian returned ${vec?.length ?? 0} dims, wanted ${EMBED_DIMS}`);
  return vec;
}

export const vecLiteral = (v: number[]) => "[" + v.map((x) => x.toPrecision(7)).join(",") + "]";

export interface SearchHit {
  chunkId: number;
  score: number;
  text: string;
  messageId: string | null;
  threadId: string | null;
  subject: string | null;
  attachment: string | null;
}

/** Hybrid search: reciprocal-rank fusion of cosine similarity and full-text rank. */
export async function searchMail(env: Env, q: { query: string; limit?: number; projectKey?: string }): Promise<SearchHit[]> {
  const vec = vecLiteral(await embedQuery(env, q.query));
  return withSql(env, async (sql) => {
    const rows = await sql<
      { chunk_id: number; score: number; text: string; gmail_message_id: string | null; gmail_thread_id: string | null; subject: string | null; filename: string | null }[]
    >`
      with sem as (
        select id, row_number() over (order by embedding <=> ${vec}::vector) as r
        from gws.content_chunks where embedding is not null order by embedding <=> ${vec}::vector limit 50),
      fts as (
        select id, row_number() over (order by ts_rank(tsv, plainto_tsquery('english', ${q.query})) desc) as r
        from gws.content_chunks where tsv @@ plainto_tsquery('english', ${q.query}) order by 2 limit 50),
      fused as (
        select coalesce(sem.id, fts.id) as id, coalesce(1.0/(60+sem.r),0) + coalesce(1.0/(60+fts.r),0) as score
        from sem full join fts on sem.id = fts.id)
      select c.id as chunk_id, f.score::float8 as score, c.text, m.gmail_message_id, m.gmail_thread_id, m.subject,
             (select a.filename from gws.gmail_attachments a where a.content_id = c.content_id order by a.id limit 1) as filename
      from fused f
      join gws.content_chunks c on c.id = f.id
      left join gws.gmail_messages m on m.id = c.message_id
      ${
        q.projectKey
          ? sql`where exists (
              select 1 from app.project_threads pt join app.projects pr on pr.id = pt.project_id
              where pr.key = ${q.projectKey}
                and pt.thread_id = coalesce(m.thread_id, (select m2.thread_id from gws.gmail_attachments a2
                      join gws.gmail_messages m2 on m2.id = a2.message_id where a2.content_id = c.content_id limit 1)))`
          : sql``
      }
      order by f.score desc limit ${Math.min(Math.max(q.limit ?? 10, 1), 50)}`;
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      score: r.score,
      text: r.text,
      messageId: r.gmail_message_id,
      threadId: r.gmail_thread_id,
      subject: r.subject,
      attachment: r.filename,
    }));
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleInput {
  id?: number;
  name: string;
  target: "gmail" | "drive";
  priority?: number;
  enabled?: boolean;
  projectKey?: string;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
}

export async function listRules(env: Env) {
  return withSql(env, (sql) =>
    sql`select r.id, r.name, r.target::text as target, r.priority, r.enabled, r.conditions, r.actions, r.version,
               p.key as project_key, r.updated_at
        from gws.ingest_rules r left join app.projects p on p.id = r.project_id order by r.priority, r.id`,
  );
}

async function projectId(sql: Sql, key?: string): Promise<number | null> {
  if (!key) return null;
  const r = await sql<{ id: number }[]>`select id from app.projects where key = ${key}`;
  if (!r[0]) throw new Error(`unknown project key "${key}": create it with project_upsert first`);
  return r[0].id;
}

export async function upsertRule(env: Env, r: RuleInput) {
  if (!Object.keys(r.conditions).length) throw new Error("a rule needs at least one condition (an empty rule would match nothing)");
  return withSql(env, async (sql) => {
    const pid = await projectId(sql, r.projectKey);
    if (r.id) {
      const rows = await sql`
        update gws.ingest_rules set name = ${r.name}, project_id = case when ${r.projectKey ? true : false} then ${pid} else project_id end,
          target = ${r.target}::gws.rule_target, priority = coalesce(${r.priority ?? null}::int, priority),
          enabled = coalesce(${r.enabled ?? null}::boolean, enabled), conditions = ${sql.json(r.conditions as never)},
          actions = ${sql.json(r.actions as never)}, version = version + 1, updated_at = now()
        where id = ${r.id} returning id, version`;
      if (!rows[0]) throw new Error(`no rule ${r.id}`);
      return rows[0];
    }
    const rows = await sql`
      insert into gws.ingest_rules (name, project_id, target, priority, enabled, conditions, actions)
      values (${r.name}, ${pid}, ${r.target}::gws.rule_target, ${r.priority ?? 100}, ${r.enabled ?? true},
              ${sql.json(r.conditions as never)}, ${sql.json(r.actions as never)}) returning id, version`;
    return rows[0];
  });
}

export async function deleteRule(env: Env, id: number): Promise<boolean> {
  return withSql(env, async (sql) => (await sql`delete from gws.ingest_rules where id = ${id} returning id`).length > 0);
}

// ---------------------------------------------------------------------------
// Projects, tasks, links
// ---------------------------------------------------------------------------

export interface ProjectInput {
  key: string;
  name: string;
  description?: string;
  background?: string;
  context?: Record<string, unknown>;
  status?: "active" | "archived" | "on_hold";
}

export async function upsertProject(env: Env, p: ProjectInput) {
  return withSql(env, async (sql) => {
    const rows = await sql`
      insert into app.projects (key, name, description, background, context, status)
      values (${p.key}, ${p.name}, ${p.description ?? null}, ${p.background ?? null}, ${sql.json((p.context ?? {}) as never)}, ${p.status ?? "active"}::app.project_status)
      on conflict (key) do update set name = excluded.name,
        description = coalesce(${p.description ?? null}, app.projects.description),
        background = coalesce(${p.background ?? null}, app.projects.background),
        context = case when ${p.context ? true : false} then ${sql.json((p.context ?? {}) as never)} else app.projects.context end,
        status = ${p.status ?? "active"}::app.project_status, updated_at = now()
      returning id, key, name, status`;
    return rows[0];
  });
}

export async function getProject(env: Env, key: string) {
  return withSql(env, async (sql) => {
    const p = (await sql`select * from app.projects where key = ${key}`)[0];
    if (!p) return null;
    const tasks = await sql`select id, title, status::text as status, priority, due_at, source_message_id from app.tasks where project_id = ${p.id} order by id`;
    const threads = await sql`
      select t.gmail_thread_id, t.subject, t.last_message_at from app.project_threads pt
      join gws.gmail_threads t on t.id = pt.thread_id where pt.project_id = ${p.id} order by t.last_message_at desc nulls last`;
    const people = await sql`
      select pe.email::text as email, pe.display_name, pp.role_note from app.project_people pp
      join gws.people pe on pe.id = pp.person_id where pp.project_id = ${p.id} order by pe.email`;
    return { project: p, tasks, threads, people };
  });
}

export async function listProjects(env: Env) {
  return withSql(env, (sql) =>
    sql`select p.key, p.name, p.status::text as status,
          (select count(*)::int from app.tasks t where t.project_id = p.id and t.status not in ('done','cancelled')) as open_tasks,
          (select count(*)::int from app.project_threads pt where pt.project_id = p.id) as threads
        from app.projects p order by p.key`,
  );
}

export async function addTask(env: Env, t: { projectKey: string; title: string; description?: string; priority?: string; dueAt?: string; sourceMessageId?: string; email: string }) {
  return withSql(env, async (sql) => {
    const pid = await projectId(sql, t.projectKey);
    let src: number | null = null;
    if (t.sourceMessageId) {
      const acc = await accountId(sql, t.email);
      const m = (await sql<{ id: number }[]>`select id from gws.gmail_messages where account_id = ${acc} and gmail_message_id = ${t.sourceMessageId}`)[0];
      if (!m) throw new Error(`message ${t.sourceMessageId} is not stored yet: read its thread first`);
      src = m.id;
    }
    return (
      await sql`insert into app.tasks (project_id, title, description, priority, due_at, source_message_id)
                values (${pid}, ${t.title}, ${t.description ?? null}, ${t.priority ?? null}, ${t.dueAt ? new Date(t.dueAt) : null}, ${src})
                returning id, title, status::text as status`
    )[0];
  });
}

export async function updateTask(env: Env, id: number, p: { status?: string; title?: string; description?: string; priority?: string }) {
  return withSql(env, async (sql) => {
    const rows = await sql`
      update app.tasks set status = coalesce(${p.status ?? null}::app.task_status, status), title = coalesce(${p.title ?? null}, title),
        description = coalesce(${p.description ?? null}, description), priority = coalesce(${p.priority ?? null}, priority), updated_at = now()
      where id = ${id} returning id, title, status::text as status`;
    if (!rows[0]) throw new Error(`no task ${id}`);
    return rows[0];
  });
}

/** Link a stored thread and/or a person (by email) to a project. */
export async function linkProject(env: Env, l: { projectKey: string; threadId?: string; personEmail?: string; roleNote?: string; email: string }) {
  return withSql(env, async (sql) => {
    const pid = await projectId(sql, l.projectKey);
    const out: { thread?: boolean; person?: boolean } = {};
    if (l.threadId) {
      const acc = await accountId(sql, l.email);
      const t = (await sql<{ id: number }[]>`select id from gws.gmail_threads where account_id = ${acc} and gmail_thread_id = ${l.threadId}`)[0];
      if (!t) throw new Error(`thread ${l.threadId} is not stored yet: call gmail_get_thread first`);
      await sql`insert into app.project_threads (project_id, thread_id) values (${pid}, ${t.id}) on conflict do nothing`;
      out.thread = true;
    }
    if (l.personEmail) {
      const person = (
        await sql<{ id: number }[]>`insert into gws.people (email) values (${l.personEmail}) on conflict (email) do update set email = excluded.email returning id`
      )[0];
      await sql`insert into app.project_people (project_id, person_id, role_note) values (${pid}, ${person.id}, ${l.roleNote ?? null})
                on conflict (project_id, person_id) do update set role_note = coalesce(excluded.role_note, app.project_people.role_note)`;
      out.person = true;
    }
    if (!out.thread && !out.person) throw new Error("name a threadId and/or personEmail to link");
    return out;
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function ingestStatus(env: Env) {
  return withSql(env, async (sql) => {
    const [c] = await sql`
      select (select count(*)::int from gws.gmail_threads) as threads, (select count(*)::int from gws.gmail_messages where gone_at is null) as messages,
             (select count(*)::int from gws.people) as people, (select count(*)::int from gws.gmail_attachments) as attachments,
             (select count(*)::int from gws.file_contents) as distinct_files, (select count(*)::int from gws.content_chunks) as chunks,
             (select count(*)::int from gws.content_chunks where embedding is not null) as embedded_chunks,
             (select count(*)::int from gws.notes) as notes, (select count(*)::int from gws.ingest_rules where enabled) as rules`;
    const jobs = await sql`select kind::text as kind, status::text as status, count(*)::int as n from gws.ingest_jobs group by 1, 2 order by 1, 2`;
    const cursors = await sql`select a.email::text as account, s.status, s.last_polled_at, s.error from gws.sync_cursors s join gws.accounts a on a.id = s.account_id`;
    return { counts: c, jobs, cursors, embedModel: EMBED_MODEL, embedDims: EMBED_DIMS };
  });
}

export { pgTextArray };
