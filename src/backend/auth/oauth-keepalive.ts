/**
 * @fileoverview Background keepalive + liveness probe for the stored Google
 * OAuth refresh tokens.
 *
 * ## Why this exists
 *
 * Google OAuth to the worker is meant to be one-time: once an account has
 * consented, the stored refresh token should keep minting access tokens
 * indefinitely, with no operator involvement and entirely independently of how
 * an MCP/API client authenticates TO this worker (that is `WORKER_API_KEY` /
 * the `/mcp` OAuth door, 1-year tokens — a separate credential in a separate
 * store).
 *
 * Two things can quietly break that, and neither surfaces on its own:
 *
 *  1. **Six months of total disuse** revokes a refresh token. Refreshing only
 *     on demand means a rarely-used account can silently age out.
 *  2. **A dead token reads as healthy.** Until this module ran, `status` stayed
 *     `"active"` in D1 while every call failed, so the account list, the UI and
 *     the health endpoint all reported green.
 *
 * So the weekly cron exercises every account's refresh token for real
 * (`forceRefreshAccessToken`, which bypasses the cached access token — reading
 * the cache would prove nothing) and records the verdict.
 *
 * Note what this does NOT fix: `invalid_grant` / `invalid_rapt` from Workspace
 * Google Cloud session control. No amount of background refreshing defeats a
 * policy that demands a human reauthenticate; the fix there is to hold no Cloud
 * scopes (see `lib/google-auth.ts`). What the keepalive buys for that case is
 * early, honest detection instead of a surprise at the next tool call.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { googleAccounts } from "@db/schemas";
import { isReauthExposed } from "@/backend/lib/google-auth";

import { forceRefreshAccessToken, NEEDS_REAUTH } from "./oauth-google";

/** Outcome of one account's keepalive refresh. */
export interface KeepaliveResult {
  /** Account email. */
  email: string;
  /** Whether the refresh token still exchanges successfully. */
  ok: boolean;
  /** Registry status after the probe. */
  status: string;
  /**
   * True when the grant carries a Google Cloud scope, so it is subject to
   * Workspace Google Cloud session control and WILL keep dying on a schedule
   * until it is re-consented without those scopes.
   */
  reauthExposed: boolean;
  /** Failure detail (truncated), when `ok` is false. */
  error?: string;
}

/**
 * Refresh every registered account's Google OAuth token and record the result.
 *
 * Accounts explicitly revoked by the operator are skipped — they are supposed
 * to be dead, and probing them would just churn. `needs_reauth` accounts ARE
 * probed, so that a re-consent clears the flag on the next sweep even if no
 * tool call happens to touch that account.
 *
 * @param env - Worker env
 * @returns One {@link KeepaliveResult} per probed account
 * @example
 * const results = await keepaliveGoogleTokens(env);
 * const broken = results.filter((r) => !r.ok);
 */
export async function keepaliveGoogleTokens(env: Env): Promise<KeepaliveResult[]> {
  const db = getDb(env);
  const rows = await db.select().from(googleAccounts);
  const results: KeepaliveResult[] = [];

  for (const row of rows) {
    if (row.status === "revoked") continue;

    const scopes = Array.isArray(row.scopesJson) ? (row.scopesJson as string[]) : null;
    const reauthExposed = isReauthExposed(scopes);

    try {
      await forceRefreshAccessToken(env, row.email);
      results.push({ email: row.email, ok: true, status: "active", reauthExposed });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      // getOAuthAccessToken already flags invalid_grant as needs_reauth; re-read
      // rather than assume, so a transient network failure is not misreported.
      const after = await db
        .select({ status: googleAccounts.status })
        .from(googleAccounts)
        .where(eq(googleAccounts.email, row.email))
        .limit(1);
      results.push({
        email: row.email,
        ok: false,
        status: after[0]?.status ?? NEEDS_REAUTH,
        reauthExposed,
        error,
      });
    }
  }

  return results;
}
