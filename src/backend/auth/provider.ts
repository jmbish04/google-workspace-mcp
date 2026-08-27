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
 * happens. Routing rules (in order):
 *
 *  1. `"workspace"` (default) → DWD impersonating `GOOGLE_USER_TO_IMPERSONATE`.
 *  2. `"personal"`            → resolves to `GOOGLE_PERSONAL_ACCOUNT_EMAIL`,
 *                               then falls through the email rules below.
 *  3. an email in the delegated Workspace domain (`@126colby.com`) with NO
 *     stored OAuth refresh token → DWD impersonating that email (`sub`).
 *  4. any other email → OAuth2 access token for that email.
 *
 * Clients and agents stay account-agnostic — they accept `account?: GoogleAccount`
 * (now `string`) and call {@link getGoogleAccessToken}.
 *
 * SECURITY (C2, 2026-07-25 audit): there is NO caller-trust check on the
 * `account` selector here — any authorized caller (anyone holding a valid
 * `gsuite_session` cookie or the `WORKER_API_KEY`, per the `agentAuthMiddleware`
 * gate on `/api/agent-tasks`, `/api/threads`, etc., and the `/agents/*` DO gate)
 * may impersonate ANY user in the Workspace domain via DWD — rule 3 above
 * honors an arbitrary `sub` with no per-caller allow-list. That is acceptable
 * for a single-tenant deployment (one trusted operator, one domain) but is
 * NOT safe for multi-tenant use: before serving more than one principal,
 * restrict which `account`/`sub` values a given caller may request (e.g. bind
 * it to the caller's own authenticated identity) in this shared function, so
 * both this REST path and the MCP `as_user` path are covered by one guard.
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
 * NO default account. Callers must name one. Kept as an (empty) export so
 * existing `account = DEFAULT_ACCOUNT` signatures still compile — but an
 * unspecified account now throws at resolve time rather than silently
 * impersonating a Workspace primary.
 */
export const DEFAULT_ACCOUNT: GoogleAccount = "";

/**
 * Resolve an account selector to a concrete email. Aliases map to the two real
 * accounts; anything empty is an error (no hidden default).
 */
export function resolveAccount(env: Env, input?: string): GoogleAccount {
  const v = (input ?? "").trim().toLowerCase();
  if (!v) {
    throw new Error(
      "No Google account specified — pass justin@126colby.com or jmbish04@gmail.com " +
        "(there is no default; DWD and the service account were removed).",
    );
  }
  if (v === "workspace" || v === "justin") {
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
