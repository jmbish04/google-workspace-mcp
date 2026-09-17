#!/usr/bin/env node
/**
 * Live auth check for google-workspace-mcp — adapted from
 * ~/.colby-ecosystem/workers/devOps/auth-check (template /oauth/* paths →
 * this server's /register, /authorize, /token; codes here are single-use, so
 * each token assertion runs its own authorize round).
 *
 * Side effects: registers 3 OAuth clients and issues 3 one-year tokens bound
 * to the default identity in production KV. Never prints a credential.
 *
 *   WORKER_API_KEY="$(tokens show WORKER_API_KEY --value-only)" node scripts/auth-check.mjs [baseUrl]
 */
import { createHash, randomBytes } from "node:crypto";

const B = process.argv[2] ?? "https://google-workspace-mcp.hacolby.workers.dev";
const KEY = process.env.WORKER_API_KEY;
if (!KEY) {
  console.error("Set the passcode in the WORKER_API_KEY environment variable.");
  process.exit(2);
}

let fails = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const get = (p) => fetch(B + p, { redirect: "manual" });
const postForm = (p, fields) =>
  fetch(B + p, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
const postJson = (p, body, headers = {}) =>
  fetch(B + p, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const toolsList = (headers) => postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers);

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const cb = "https://claude.ai/api/mcp/auth_callback";

// Discovery is unauthenticated.
t("protected-resource metadata is public", (await get("/.well-known/oauth-protected-resource")).status === 200);
const asMeta = await (await get("/.well-known/oauth-authorization-server")).json();
t("AS metadata advertises S256 only", JSON.stringify(asMeta.code_challenge_methods_supported) === '["S256"]');

// Registration: plain http only to loopback.
t("register http non-loopback refused", (await postJson("/register", { redirect_uris: ["http://evil.example/cb"] })).status === 400);
t("register http localhost allowed", (await postJson("/register", { redirect_uris: ["http://localhost:33418/cb"] })).status === 201);
const client = await (await postJson("/register", { redirect_uris: [cb], client_name: "auth-check" })).json();
const cid = client.client_id;
const authorize = (extra) =>
  get(`/authorize?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent(cb)}&state=s1${extra}`);
const errorOf = (res) => new URL(res.headers.get("location") ?? "https://x").searchParams.get("error");

// PKCE S256 is mandatory (errors redirect back to the registered redirect_uri).
t("authorize without PKCE refused", errorOf(await authorize("")) === "invalid_request");
t("authorize with plain PKCE refused", errorOf(await authorize(`&code_challenge=${challenge}&code_challenge_method=plain`)) === "invalid_request");

// The page.
const pageRes = await authorize(`&code_challenge=${challenge}&code_challenge_method=S256`);
const page = await pageRes.text();
t("authorize page renders", pageRes.status === 200);
t("page names the receiving host", page.includes("connect claude.ai"));
t('page says "Passcode", never the key name', page.includes("Passcode") && !/WORKER_API_KEY/i.test(page));
t("page still offers Google sign-in", page.includes("accounts.google.com"));
const reqId = page.match(/name="req" value="([^"]+)"/)?.[1] ?? "";

const bad = await postForm("/authorize", { req: reqId, passcode: "wrong" });
t("wrong passcode -> 401, no redirect", bad.status === 401 && !bad.headers.get("location"));
t("wrong-passcode page never names the key", !/WORKER_API_KEY/i.test(await bad.text()));
const ok = await postForm("/authorize", { req: reqId, passcode: KEY });
const loc = new URL(ok.headers.get("location") ?? "https://x");
t("right passcode -> 303 with code+state", ok.status === 303 && loc.origin + loc.pathname === cb && loc.searchParams.get("state") === "s1" && !!loc.searchParams.get("code"));

// Token endpoint (codes are single-use: one fresh authorize round per assertion).
async function freshCode() {
  const p = await (await authorize(`&code_challenge=${challenge}&code_challenge_method=S256`)).text();
  const r = await postForm("/authorize", { req: p.match(/name="req" value="([^"]+)"/)?.[1] ?? "", passcode: KEY });
  return new URL(r.headers.get("location") ?? "https://x").searchParams.get("code") ?? "";
}
const tokenForm = (code, extra) => ({ grant_type: "authorization_code", code, redirect_uri: cb, client_id: cid, ...extra });
t("token with wrong verifier refused", (await postForm("/token", tokenForm(await freshCode(), { code_verifier: "nope" }))).status === 400);
t("token without verifier refused", (await postForm("/token", tokenForm(await freshCode(), {}))).status === 400);
const tok = await (await postForm("/token", tokenForm(await freshCode(), { code_verifier: verifier }))).json();
t("token issued, expires_in = 365 days", tok.expires_in === 31536000 && !!tok.access_token, `expires_in=${tok.expires_in}`);

// /mcp gate.
const unauth = await toolsList({});
t(
  "no credentials -> 401 + WWW-Authenticate resource_metadata",
  unauth.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(unauth.headers.get("www-authenticate") ?? ""),
);
t("401 body never names the key", !/WORKER_API_KEY/i.test(await unauth.text()));
t("Bearer <oauth token> accepted", (await toolsList({ authorization: `Bearer ${tok.access_token}` })).status === 200);
t("Bearer <WORKER_API_KEY> accepted", (await toolsList({ authorization: `Bearer ${KEY}` })).status === 200);
const garbage = await toolsList({ authorization: "Bearer nope" });
t("Bearer <garbage> -> 401 + WWW-Authenticate", garbage.status === 401 && !!garbage.headers.get("www-authenticate"));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
