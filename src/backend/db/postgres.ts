/**
 * @file src/backend/db/postgres.ts
 * @description The Postgres connection, reached through Hyperdrive.
 *
 * Postgres on LXC 109 is the system of record (decided 2026-10-03; see
 * `docs/decisions/2026-10-03-postgres-vs-cloudflare-system-of-record.md`).
 * The Worker never holds the database credentials — the Hyperdrive config does,
 * and `env.HYPERDRIVE.connectionString` hands back a pooled local connection
 * string that is only valid inside the request.
 *
 * Two rules the driver has to follow on Workers, and both bite silently:
 *
 * 1. `max: 5` and `fetch_types: false` — Hyperdrive is already the pool, so a
 *    second pool in the isolate just burns connections, and the startup
 *    type-introspection round trip is wasted on every cold start. But NEVER
 *    `prepare: false`: Cloudflare documents that it breaks under Hyperdrive's
 *    transaction pooling, and it cost a 500 on the health route to learn.
 * 2. **A client is per-request.** A connection opened in one request must not
 *    be reused by another — Workers may run them in different contexts, and a
 *    cached client outlives the I/O context it was created in. So `getSql()`
 *    builds one per call and the caller closes it (or hands it to
 *    `ctx.waitUntil(sql.end())`).
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** Thrown when the binding is absent, rather than failing later as a null deref. */
export class HyperdriveUnavailableError extends Error {
  constructor() {
    super("env.HYPERDRIVE is not bound — the Postgres system of record is unreachable from this Worker.");
    this.name = "HyperdriveUnavailableError";
  }
}

/** A raw postgres.js client for this request. The caller MUST end it. */
export function getSql(env: Env): postgres.Sql {
  const hyperdrive = (env as { HYPERDRIVE?: Hyperdrive }).HYPERDRIVE;
  if (!hyperdrive) throw new HyperdriveUnavailableError();
  return postgres(hyperdrive.connectionString, {
    // Hyperdrive pools on its own; a second pool here wastes origin connections.
    max: 5,
    // No array types in this schema, so skip the extra type-discovery round trip.
    fetch_types: false,
    // `prepare` is left at its default (true) ON PURPOSE. Cloudflare's docs are
    // explicit: do NOT set `prepare: false` with Postgres.js, because it then
    // sends extra protocol messages to discover parameter types before every
    // query, and Hyperdrive's transaction pooling mode does not reliably
    // support that — "this can cause queries to hang or fail intermittently".
    // Measured 2026-10-03: with `prepare: false`, POST /api/health/run returned
    // 500 in production while every other route stayed 200.
    // https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
  });
}

/** Drizzle bound to a request-scoped client. The caller MUST end `sql`. */
export function getPg(env: Env): { db: PostgresJsDatabase; sql: postgres.Sql } {
  const sql = getSql(env);
  return { db: drizzle(sql), sql };
}

/**
 * Run `fn` against Postgres and always close the connection, even on throw.
 * Prefer this over `getPg` — a leaked client holds an origin connection open
 * until it times out, and the origin is a box in a house.
 */
export async function withPg<T>(env: Env, fn: (db: PostgresJsDatabase, sql: postgres.Sql) => Promise<T>): Promise<T> {
  const { db, sql } = getPg(env);
  try {
    return await fn(db, sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
