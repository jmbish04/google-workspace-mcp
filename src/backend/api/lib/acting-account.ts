/**
 * @fileoverview Resolve which signed-in Google account a REST call acts as.
 *
 * Shared by `/api/tools/*` and `/api/drive/*`. Every account is a regular
 * signed-in OAuth account (no domain-wide delegation), so `as_user` must name
 * an ACTIVE account — we return that account's real token ref. This both:
 *   - prevents a WORKER_API_KEY holder from impersonating an arbitrary domain
 *     user by passing an unknown `as_user`, and
 *   - keys REST-created assets by the same ref an equivalent `/mcp` call uses,
 *     so they show up in that account's assets feed.
 */

import { listCaptureAccounts } from "@/backend/gmail/sync-service";

/** An error carrying an HTTP `status` the API error handler mirrors onto the response. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Resolve the token `ref` to act as. With `asUser`, return the matching active
 * account's ref (400 if none matches). Without it, return the first active
 * account (400 if none is signed in).
 */
export async function resolveActingRef(env: Env, asUser?: string): Promise<string> {
  const accounts = await listCaptureAccounts(env);
  if (asUser) {
    const match = accounts.find((a) => a.email === asUser.toLowerCase());
    if (!match) {
      throw httpError(400, `Unknown as_user "${asUser}" — not a signed-in account. Sign in at /api/auth/google/oauth/start?label=${encodeURIComponent(asUser)}.`);
    }
    return match.ref;
  }
  if (!accounts.length) {
    throw httpError(400, "No signed-in Google account. Sign in at /api/auth/google/oauth/start, or pass `as_user`.");
  }
  return accounts[0].ref;
}
