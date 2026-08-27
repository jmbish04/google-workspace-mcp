/**
 * @fileoverview Unified Google access-token provider across a DYNAMIC set of
 * accounts.
 *
 * Historically this worker had a fixed two-account model
 * (`"workspace"` via DWD, `"personal"` via OAuth2). It is now a dynamic
 * multi-account registry: any number of Google accounts can be authorized via
 * OAuth, and the account selector is a free-form string (an email, or one of
 * the legacy aliases `"workspace"` / `"personal"`).
 *
 * {@link getGoogleAccessToken} is the single seam where account resolution
 * happens. OAuth-ONLY (DWD and the service account were removed):
 *
 *  1. empty / `"workspace"` / `"justin"` → the Workspace OAuth account
 *     (`GOOGLE_WORKSPACE_ACCOUNT_EMAIL`, default justin@126colby.com).
 *  2. `"personal"` / `"jmbish04"`        → the consumer OAuth account
 *     (`GOOGLE_PERSONAL_ACCOUNT_EMAIL`, default jmbish04@gmail.com).
 *  3. any other value                    → treated as a literal email.
 *
 * Every account resolves to a stored OAuth refresh token; if none exists the
 * call throws an actionable "log in" error. Clients and agents stay
 * account-agnostic — they accept `account?: string` and call this seam.
 *
 * SECURITY: this deployment is single-tenant (one trusted operator, two of the
 * operator's own OAuth accounts). Before serving more than one principal,
 * restrict which `account` values a caller may request (bind it to the caller's
 * authenticated identity) in this shared function.
 */

import { getDb } from "@/backend/db";
import { googleAccounts } from "@db/schemas";

import { getOAuthAccessToken, hasOAuthRefreshToken } from "./oauth-google";

/**
 * Which Google account a request targets: an email address, or one of the
 * aliases `"workspace"`/`"justin"` (→ justin@126colby.com) and
 * `"personal"`/`"jmbish04"` (→ jmbish04@gmail.com). OAuth-only — no DWD, no
 * service account.
 */
export type GoogleAccount = string;

/**
 * Default account when a caller does not specify one — the `"workspace"` alias,
 * which now resolves to a real OAuth account (justin@126colby.com), NOT a service
 * account or DWD impersonation. Background agents (orchestrator, RPC) rely on
 * this default; it is just another OAuth identity.
 */
export const DEFAULT_ACCOUNT: GoogleAccount = "workspace";

/**
 * Resolve an account selector to a concrete email. Empty/`"workspace"`/`"justin"`
 * → the Workspace OAuth account; `"personal"`/`"jmbish04"` → the consumer OAuth
 * account; any other value is treated as a literal email. No DWD, no service
 * account — every result is an OAuth identity.
 */
export function resolveAccount(env: Env, input?: string): GoogleAccount {
  const v = (input ?? "").trim().toLowerCase();
  if (!v || v === "workspace" || v === "justin") {
    return (env.GOOGLE_WORKSPACE_ACCOUNT_EMAIL ?? "justin@126colby.com").toLowerCase();
  }
  if (v === "personal" || v === "jmbish04") {
    return (env.GOOGLE_PERSONAL_ACCOUNT_EMAIL ?? "jmbish04@gmail.com").toLowerCase();
  }
  return v;
}

/**
 * Get a bearer access token for the chosen account + scopes via OAuth only.
 * Throws (actionable) if the account isn't specified or has no stored OAuth
 * credentials. No Domain-Wide Delegation, no service account.
 *
 * @param env - Worker env
 * @param account - Target account (email or alias; required)
 * @param scopes - Google OAuth scopes to request
 * @returns A bearer access token string
 */
export async function getGoogleAccessToken(
  env: Env,
  account: GoogleAccount,
  scopes: string[],
): Promise<string> {
  const email = resolveAccount(env, account);
  if (!(await hasOAuthRefreshToken(env, email))) {
    throw new Error(
      `${email} has no stored OAuth credentials — log in at ` +
        `/api/auth/google/oauth/start?label=${encodeURIComponent(email)}.`,
    );
  }
  return getOAuthAccessToken(env, email, scopes);
}

/** Human-readable email for an account selector (for logging / display). */
export function accountEmail(env: Env, account: GoogleAccount): string {
  return resolveAccount(env, account);
}

/** A summary of one authorized account for listing / display. */
export interface AuthorizedAccount {
  /** Account email (or the synthetic `"workspace"` selector). */
  email: string;
  /** Auth mechanism. */
  kind: "workspace_dwd" | "oauth";
  /** Human-readable label. */
  label: string;
  /** Whether this is the default selection. */
  isDefault: boolean;
  /** Lifecycle status. */
  status: string;
  /** Granted scopes, if known. */
  scopes: string[] | null;
  /** When the account was authorized, ISO string or null. */
  authorizedAt: string | null;
}

/**
 * List the account registry from D1 (real OAuth accounts).
 *
 * DWD was dropped (per-account OAuth only), so there is no synthetic
 * `workspace` account any more — every card is a genuine authorized identity.
 *
 * @param env - Worker env
 * @returns All authorized accounts.
 */
export async function listAuthorizedAccounts(env: Env): Promise<AuthorizedAccount[]> {
  const db = getDb(env);
  const rows = await db.select().from(googleAccounts);

  return rows.map((r) => ({
    email: r.email,
    // No account is created as workspace_dwd any more, but the backend token
    // path (tokenProvider `dwd:` refs, listCaptureAccounts) still models DWD as
    // a fallback, so legacy rows are surfaced with their stored kind rather than
    // silently coerced. The frontend renders every account as OAuth regardless.
    kind: r.kind === "workspace_dwd" ? "workspace_dwd" : "oauth",
    label: r.label,
    isDefault: Boolean(r.isDefault),
    status: r.status,
    scopes: Array.isArray(r.scopesJson) ? (r.scopesJson as string[]) : null,
    authorizedAt: r.authorizedAt ? r.authorizedAt.toISOString() : null,
  }));
}
