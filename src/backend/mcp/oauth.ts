/**
 * @fileoverview Minimal OAuth 2.1 authorization server for the MCP endpoint,
 * per the MCP authorization spec (2025-06-18) + RFC 8414 / 7591 / 7636 (PKCE).
 *
 * This lets spec-compliant MCP clients (e.g. the claude.ai web "custom
 * connector") authorize automatically: discover metadata → dynamically register
 * → /authorize (a page offering Passcode or Google sign-in) → /token → call /mcp
 * with the issued Bearer access token.
 *
 * The access token we mint is opaque and maps (in KV) to an account ref: the
 * user's Google `sub` after a Google sign-in, or the default Workspace email
 * after a Passcode grant. Tool calls then use the Google refresh token already
 * stored in KV (see tokenProvider). We never expose Google tokens to the MCP
 * client.
 *
 * All state lives in the existing `SESSIONS` KV, namespaced by prefix:
 *   oauthclient:<client_id>   registered client (long-lived, no TTL)
 *   oauthreq:<req_id>         pending /authorize awaiting Passcode or Google (10 min)
 *   oauthcode:<code>          issued authorization code (5 min, single-use)
 *   oauthtok:<access_token>   access token → { sub, scope, clientId } (1 y)
 *   oauthrt:<refresh_token>   refresh token → { sub, scope, clientId } (~13 mo)
 */

import { resolveAccount } from "@/backend/auth/provider";

import { constantTimeEqual, toBase64Url } from "../lib/crypto";
import { getSecret, getWorkerApiKey } from "../utils/secrets";
import { SCOPES as SCOPES_SUPPORTED } from "./scopes";

const ACCESS_TTL = 60 * 60 * 24 * 365; // 1 year — MCP clients shouldn't re-auth often
const REFRESH_TTL = 60 * 60 * 24 * 400; // ~13 months — outlives the access token
const CODE_TTL = 300; // 5 minutes
const REQ_TTL = 600; // 10 minutes


// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function oauthBaseUrl(env: Env, request: Request): string {
  return (env as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL || new URL(request.url).origin;
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** PKCE S256: base64url(SHA-256(verifier)). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  });
}

function oauthError(error: string, description?: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

// KV typed accessors -------------------------------------------------------

type Client = { client_id: string; redirect_uris: string[]; client_name?: string; created_at: number };
type AuthReq = { clientId: string; redirectUri: string; codeChallenge: string; clientState?: string; scope?: string };
type CodeRec = { clientId: string; redirectUri: string; codeChallenge: string; sub: string; scope?: string };
type TokRec = { sub: string; scope?: string; clientId: string };

const kv = (env: Env) => env.SESSIONS;
const getJson = async <T>(env: Env, key: string): Promise<T | null> => {
  const raw = await kv(env).get(key);
  return raw ? (JSON.parse(raw) as T) : null;
};

// ---------------------------------------------------------------------------
// Public API used by the rest of the worker
// ---------------------------------------------------------------------------

/** Resolve an issued MCP access token to its account ref (Google `sub`, or an email), or null. */
export async function resolveAccessToken(env: Env, token: string): Promise<string | null> {
  const rec = await getJson<TokRec>(env, `oauthtok:${token}`);
  return rec?.sub ?? null;
}

/**
 * Complete a pending /authorize once the person has authenticated — from the
 * Google callback when it detects an `mcp:<reqId>` state, or from the Passcode
 * POST above (which passes the default Workspace identity). Consumes `reqId`,
 * so a replay of the same request is refused.
 *
 * @param env - Worker env
 * @param reqId - pending authorize request id
 * @param sub - account ref to bind the grant to (Google `sub`, or an email)
 * @returns the client redirect URL (with code+state), or null if reqId is unknown/expired
 */
export async function completeMcpAuthorize(env: Env, reqId: string, sub: string): Promise<string | null> {
  const req = await getJson<AuthReq>(env, `oauthreq:${reqId}`);
  if (!req) return null;
  await kv(env).delete(`oauthreq:${reqId}`);

  const code = randomToken();
  const rec: CodeRec = {
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    sub,
    // The token grants the full Google scope set regardless of what the client
    // requested (tools enforce no per-scope subset), so advertise the real
    // granted scope rather than echoing a narrower request back (scope-confusion).
    scope: SCOPES_SUPPORTED.join(" "),
  };
  await kv(env).put(`oauthcode:${code}`, JSON.stringify(rec), { expirationTtl: CODE_TTL });

  const to = new URL(req.redirectUri);
  to.searchParams.set("code", code);
  if (req.clientState) to.searchParams.set("state", req.clientState);
  return to.toString();
}

// ---------------------------------------------------------------------------
// Route handler — returns a Response for OAuth paths, or null to fall through.
// ---------------------------------------------------------------------------

export async function handleOAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const p = url.pathname;
  const base = oauthBaseUrl(env, request);

  const isOAuthPath =
    p.startsWith("/.well-known/oauth-protected-resource") ||
    p.startsWith("/.well-known/oauth-authorization-server") ||
    p === "/register" ||
    p === "/authorize" ||
    p === "/token";
  if (!isOAuthPath) return null;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // --- Discovery: protected resource metadata -----------------------------
  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    return json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ["header"],
    });
  }

  // --- Discovery: authorization server metadata (RFC 8414) ----------------
  if (p.startsWith("/.well-known/oauth-authorization-server")) {
    return json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: SCOPES_SUPPORTED,
    });
  }

  // --- Dynamic client registration (RFC 7591) -----------------------------
  if (p === "/register") {
    if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
    let body: { redirect_uris?: unknown; client_name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return oauthError("invalid_request", "Body must be JSON");
    }
    const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string" && isValidRedirect(u))) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of https (or http://localhost) URIs");
    }
    const clientId = `client_${randomToken(16)}`;
    const client: Client = {
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      created_at: Math.floor(Date.now() / 1000),
    };
    await kv(env).put(`oauthclient:${clientId}`, JSON.stringify(client));
    return json(
      {
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: client.client_name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: client.created_at,
      },
      201,
    );
  }

  // --- Authorization endpoint: Passcode submit ----------------------------
  // The passcode is WORKER_API_KEY (never named on the page or in errors). A
  // correct one completes the pending request bound to the default Workspace
  // identity, but only for a host on PASSCODE_REDIRECT_HOSTS; a wrong one
  // re-renders the page and keeps the request alive.
  if (p === "/authorize" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    const reqId = form.get("req") ?? "";
    const pending = await getJson<AuthReq>(env, `oauthreq:${reqId}`);
    if (!pending) return oauthError("invalid_request", "Authorization request expired — please retry.");
    const pendingUrl = new URL(pending.redirectUri);
    // Registration is open, so anyone can register their own redirect_uri and
    // mail the /authorize link. The passcode door grants a year of full
    // Workspace access, so it opens only for the hosts we actually ship to;
    // Google sign-in stays open to everyone, since it binds the signer's own
    // identity rather than the default one.
    if (!isPasscodeRedirectHost(pendingUrl.hostname)) {
      console.warn("[mcp-oauth] passcode refused for an unlisted redirect host", {
        host: pendingUrl.host,
        clientId: pending.clientId,
      });
      return authorizePage(
        {
          host: pendingUrl.host,
          reqId,
          googleUrl: await googleAuthorizeUrl(env, base, reqId),
          error: "This site can't be connected with a passcode. Sign in with Google instead.",
        },
        403,
      );
    }
    // An unreadable key is treated as absent rather than thrown: a Secret Store
    // hiccup should re-render the page, not 500. Still fail-closed — absent can
    // never match, so nothing is issued.
    const key = await getWorkerApiKey(env).catch(() => undefined);
    if (!key || !constantTimeEqual(form.get("passcode") ?? "", key)) {
      // A brute-force run against production is otherwise invisible. Neither
      // the credential's name nor the submitted value is logged.
      console.warn("[mcp-oauth] failed passcode attempt", { host: pendingUrl.host, clientId: pending.clientId });
      return authorizePage(
        {
          host: pendingUrl.host,
          reqId,
          googleUrl: await googleAuthorizeUrl(env, base, reqId),
          error: "That passcode is not right.",
        },
        401,
      );
    }
    const redirectTo = await completeMcpAuthorize(env, reqId, resolveAccount(env));
    if (!redirectTo) return oauthError("invalid_request", "Authorization request expired — please retry.");
    return new Response(null, { status: 303, headers: { location: redirectTo, "cache-control": "no-store" } });
  }

  // --- Authorization endpoint ---------------------------------------------
  if (p === "/authorize") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const responseType = q.get("response_type");
    const codeChallenge = q.get("code_challenge") ?? "";
    const method = q.get("code_challenge_method");
    const state = q.get("state") ?? undefined;
    const scope = q.get("scope") ?? undefined;

    const client = await getJson<Client>(env, `oauthclient:${clientId}`);
    // Errors that can't be safely redirected must render, not redirect.
    if (!client) return oauthError("invalid_client", "Unknown client_id");
    if (!client.redirect_uris.includes(redirectUri)) {
      return oauthError("invalid_request", "redirect_uri not registered for this client");
    }
    // From here, errors redirect back to the (validated) redirect_uri.
    const back = (error: string, desc?: string) => {
      const to = new URL(redirectUri);
      to.searchParams.set("error", error);
      if (desc) to.searchParams.set("error_description", desc);
      if (state) to.searchParams.set("state", state);
      return Response.redirect(to.toString(), 302);
    };
    if (responseType !== "code") return back("unsupported_response_type");
    if (!codeChallenge || method !== "S256") return back("invalid_request", "PKCE S256 required");

    // Store the pending request, then let the person choose: Passcode (POST
    // /authorize) or Google sign-in (req id rides Google's `state`).
    const reqId = randomToken(18);
    const req: AuthReq = { clientId, redirectUri, codeChallenge, clientState: state, scope };
    await kv(env).put(`oauthreq:${reqId}`, JSON.stringify(req), { expirationTtl: REQ_TTL });

    return authorizePage({
      host: new URL(redirectUri).host,
      reqId,
      googleUrl: await googleAuthorizeUrl(env, base, reqId),
    });
  }

  // --- Token endpoint ------------------------------------------------------
  if (p === "/token") {
    if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type");

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const redirectUri = form.get("redirect_uri") ?? "";
      const clientId = form.get("client_id") ?? "";
      const codeVerifier = form.get("code_verifier") ?? "";

      const rec = await getJson<CodeRec>(env, `oauthcode:${code}`);
      if (!rec) return oauthError("invalid_grant", "Unknown or expired code");
      await kv(env).delete(`oauthcode:${code}`); // single use
      if (rec.clientId !== clientId) return oauthError("invalid_grant", "client_id mismatch");
      if (rec.redirectUri !== redirectUri) return oauthError("invalid_grant", "redirect_uri mismatch");
      if (!codeVerifier || (await s256(codeVerifier)) !== rec.codeChallenge) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      return issueTokens(env, rec.sub, rec.scope, rec.clientId);
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const rec = await getJson<TokRec>(env, `oauthrt:${refreshToken}`);
      if (!rec) return oauthError("invalid_grant", "Unknown or expired refresh_token");
      // OAuth 2.1 §4.3.1: the refresh token must have been issued to the
      // requesting client. Reject cross-client replay.
      if (rec.clientId !== (form.get("client_id") ?? "")) {
        return oauthError("invalid_grant", "refresh_token was not issued to this client");
      }
      return issueTokens(env, rec.sub, rec.scope, rec.clientId, refreshToken);
    }

    return oauthError("unsupported_grant_type");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token issuance
// ---------------------------------------------------------------------------

async function issueTokens(
  env: Env,
  sub: string,
  scope: string | undefined,
  clientId: string,
  reuseRefresh?: string,
): Promise<Response> {
  const accessToken = `at_${randomToken()}`;
  await kv(env).put(`oauthtok:${accessToken}`, JSON.stringify({ sub, scope, clientId } satisfies TokRec), {
    expirationTtl: ACCESS_TTL,
  });

  let refreshToken = reuseRefresh;
  if (!refreshToken) {
    refreshToken = `rt_${randomToken()}`;
    await kv(env).put(`oauthrt:${refreshToken}`, JSON.stringify({ sub, scope, clientId } satisfies TokRec), {
      expirationTtl: REFRESH_TTL,
    });
  }

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
    scope,
  });
}

// ---------------------------------------------------------------------------

/**
 * Hosts whose pending request the Passcode door will complete. Everything else
 * has to use Google sign-in. Any client may still register and use Google
 * sign-in — this list only gates the door that hands out the DEFAULT
 * Workspace identity to whoever holds the passcode.
 */
const PASSCODE_REDIRECT_HOSTS = ["claude.ai", "localhost", "127.0.0.1", "[::1]"];

/**
 * Whether the Passcode door may complete a request redirecting to this host.
 *
 * @param hostname - `URL.hostname` of the pending redirect_uri (no port; IPv6 in brackets)
 * @returns true for claude.ai, any `*.claude.ai` subdomain, and loopback
 */
function isPasscodeRedirectHost(hostname: string): boolean {
  return PASSCODE_REDIRECT_HOSTS.includes(hostname) || hostname.endsWith(".claude.ai");
}

function isValidRedirect(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:") return true;
    // Plain http only to loopback, where native/CLI clients listen.
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Google consent URL that completes pending request `reqId` via
 * /auth/google/callback (`state = mcp:<reqId>`).
 *
 * @param env - Worker env
 * @param base - public origin of this Worker
 * @param reqId - pending authorize request id
 * @returns the URL, or null when Google sign-in is not configured
 */
async function googleAuthorizeUrl(env: Env, base: string, reqId: string): Promise<string | null> {
  const clientId = await getSecret(env, "GOOGLE_CLIENT_ID");
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/auth/google/callback`,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: SCOPES_SUPPORTED.join(" "),
    state: `mcp:${reqId}`,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The consent page. Registration is open, so it names the host that will
 * receive the grant (a phishing link reads "connect evil.example" before the
 * passcode goes in). It says "Passcode" and never names the credential.
 *
 * @param o - receiving host, pending request id, optional Google URL and error
 * @param status - HTTP status (401 after a wrong passcode)
 * @returns the HTML response
 */
function authorizePage(
  o: { host: string; reqId: string; googleUrl: string | null; error?: string },
  status = 200,
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect · Google Workspace MCP</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#131313;color:#fafafa;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:360px;background:#1c1c1c;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px}
h1{margin:0 0 6px;font-size:19px;font-weight:600}
p.sub{margin:0 0 22px;font-size:13.5px;color:#a1a1a1}
label{display:block;font-size:13px;font-weight:500;margin-bottom:7px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;font-size:15px;color:inherit;background:#141414;border:1px solid rgba(255,255,255,.16);border-radius:9px}
input[type=password]:focus{outline:none;border-color:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.16)}
button,a.alt{display:block;width:100%;box-sizing:border-box;margin-top:14px;padding:10px 12px;font-size:15px;font-weight:600;text-align:center;border:0;border-radius:9px;cursor:pointer;text-decoration:none}
button{color:#06240f;background:#4ade80}
a.alt{color:#fafafa;background:#262626}
.err{margin:0 0 16px;padding:9px 11px;font-size:13px;border-radius:9px;color:#fecaca;background:rgba(239,68,68,.13);border:1px solid rgba(239,68,68,.3)}
.or{margin:18px 0 0;text-align:center;font-size:12px;color:#7d7d7d}
</style></head><body><main class="card">
<h1>Google Workspace MCP</h1>
<p class="sub">Enter the passcode to connect ${esc(o.host)}. It stays connected for one year.</p>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="req" value="${esc(o.reqId)}">
<label for="passcode">Passcode</label>
<input id="passcode" name="passcode" type="password" required autofocus autocomplete="current-password">
<button type="submit">Authorize</button>
</form>
${o.googleUrl ? `<p class="or">or</p><a class="alt" href="${esc(o.googleUrl)}">Sign in with Google</a>` : ""}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

