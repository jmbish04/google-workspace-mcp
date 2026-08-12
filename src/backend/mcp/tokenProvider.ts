/**
 * @fileoverview KV-backed Google OAuth token provider.
 *
 * Stores the per-user refresh token (`gwsuser:<sub>`) and caches minted
 * access tokens (`gwstok:<sub>`) in the SESSIONS KV namespace, refreshing
 * via Google's token endpoint when the cached token is missing or expiring.
 */
import { getSecret, hasDedicatedOAuthClient } from "../utils/secrets";
import { getDwdAccessToken, getServiceAccountAccessToken } from "./dwd";
import { getOAuthAccessToken, hasOAuthRefreshToken } from "../auth/oauth-google";
import { API_SCOPES } from "./scopes";

/**
 * Accounts that must use OAuth and never fall back to Domain-Wide Delegation.
 * An account is OAuth-only if it's listed here, named in the
 * `GOOGLE_OAUTH_ONLY_ACCOUNTS` env (comma-separated), or has a dedicated OAuth
 * client secret configured. For these, a missing token is a "log in" error
 * rather than a confusing DWD `unauthorized_client`.
 */
const DEFAULT_OAUTH_ONLY = new Set(["justin@126colby.com"]);

/**
 * Consumer Google domains that can NEVER use Domain-Wide Delegation — DWD only
 * impersonates users inside a Workspace domain the service account is trusted
 * for, so a `@gmail.com`/`@googlemail.com` identity is unreachable via DWD and
 * must go through per-user OAuth. Treating them as OAuth-only turns a missing
 * token into an actionable "log in" error instead of a confusing DWD failure.
 */
const CONSUMER_GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** True for consumer Google mailboxes (gmail.com / googlemail.com). */
export function isConsumerGoogleAccount(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return CONSUMER_GOOGLE_DOMAINS.has(domain);
}

async function isOAuthOnlyAccount(env: Env, email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (DEFAULT_OAUTH_ONLY.has(e)) return true;
  if (isConsumerGoogleAccount(e)) return true; // consumer Gmail → OAuth-only, DWD impossible
  const configured = (env.GOOGLE_OAUTH_ONLY_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (configured.includes(e)) return true;
  return hasDedicatedOAuthClient(env, e);
}

export type GwsUser = {
  sub: string;
  email?: string;
  refreshToken: string;
  scopes: string[];
  updatedAt: number;
};

const USER_PREFIX = "gwsuser:";
const TOK_PREFIX = "gwstok:";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function saveUser(env: Env, user: GwsUser): Promise<void> {
  await env.SESSIONS.put(USER_PREFIX + user.sub, JSON.stringify(user));
}

export async function getUser(env: Env, sub: string): Promise<GwsUser | null> {
  const raw = await env.SESSIONS.get(USER_PREFIX + sub);
  return raw ? (JSON.parse(raw) as GwsUser) : null;
}

export async function getAccessToken(env: Env, sub: string): Promise<string> {
  // Explicit `as_user`: a `dwd:<email>` account ref asks to act AS that email.
  // Prefer a stored per-user OAuth refresh token when one exists — this is the
  // ONLY path that works for consumer / standalone mailboxes and for any domain
  // where the service account has no Domain-Wide Delegation grant (DWD returns
  // `unauthorized_client` there). Fall back to DWD impersonation for Workspace
  // users that were authorized via an admin DWD grant instead of OAuth consent.
  if (sub.startsWith("dwd:")) {
    const email = sub.slice(4);
    if (await hasOAuthRefreshToken(env, email)) {
      return getOAuthAccessToken(env, email, API_SCOPES);
    }
    // OAuth-only accounts (e.g. justin@126colby.com) never use DWD — surface a
    // clear "log in" error instead of Google's `unauthorized_client`.
    if (await isOAuthOnlyAccount(env, email)) {
      throw new Error(
        `${email} is configured for OAuth (DWD disabled) but has no stored credentials. ` +
          `Set its refresh-token secret, or log in at /api/auth/google/oauth/start?label=${encodeURIComponent(email)}.`,
      );
    }
    return getDwdAccessToken(env, email);
  }

  // Service-account own identity: reaches any Drive item shared with the SA's
  // email. No impersonation, no domain — works for consumer-owned files too.
  if (sub === "sa") {
    return getServiceAccountAccessToken(env);
  }

  // Global default impersonation: when GOOGLE_USER_TO_IMPERSONATE is set, every
  // call acts as that user via DWD — no per-tool `as_user` needed. Clear the var
  // to fall back to the OAuth caller's own token.
  const forced = env.GOOGLE_USER_TO_IMPERSONATE?.trim();
  if (forced) {
    return getDwdAccessToken(env, forced);
  }

  const cached = await env.SESSIONS.get(TOK_PREFIX + sub);
  if (cached) {
    const { access_token, exp } = JSON.parse(cached) as { access_token: string; exp: number };
    if (exp - 60 > Math.floor(Date.now() / 1000)) return access_token;
  }

  const user = await getUser(env, sub);
  if (!user) throw new Error(`No Google credentials for sub ${sub}. Sign in at /auth/google.`);

  const clientId = await getSecret(env, "GOOGLE_CLIENT_ID");
  const clientSecret = await getSecret(env, "GOOGLE_CLIENT_SECRET");
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID secret not configured");
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET secret not configured");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: user.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const exp = Math.floor(Date.now() / 1000) + json.expires_in;
  await env.SESSIONS.put(
    TOK_PREFIX + sub,
    JSON.stringify({ access_token: json.access_token, exp }),
    { expirationTtl: Math.max(60, json.expires_in) },
  );
  return json.access_token;
}
