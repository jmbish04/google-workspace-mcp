/**
 * @fileoverview Tests for the pure helpers of `scripts/setup-dev-oauth.mjs`
 * (dev OAuth setup: client file parsing, Google probe classification,
 * redirect lists, Worker secret names).
 *
 * The script lives outside `src/`, so it is loaded by file URL at runtime
 * (TypeScript does not type-check the `.mjs` file).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const scriptUrl = pathToFileURL(join(process.cwd(), "scripts", "setup-dev-oauth.mjs")).href;
let m: any;
beforeAll(async () => {
  m = await import(/* @vite-ignore */ scriptUrl);
});

const BASE = "https://google-workspace-mcp-dev.hacolby.workers.dev";
const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("parseClientFile", () => {
  it("reads a web client file", () => {
    const c = m.parseClientFile({ web: { client_id: "id.apps.googleusercontent.com", client_secret: "s", project_id: "p1", redirect_uris: [`${BASE}/x`] } });
    expect(c).toEqual({ clientId: "id.apps.googleusercontent.com", clientSecret: "s", projectId: "p1", type: "web", redirectUris: [`${BASE}/x`] });
  });

  it("marks a desktop (installed) client", () => {
    expect(m.parseClientFile({ installed: { client_id: "a", client_secret: "b" } }).type).toBe("installed");
  });

  it("throws when the secret is missing", () => {
    expect(() => m.parseClientFile({ web: { client_id: "a" } })).toThrow(/client_secret/);
  });
});

describe("requiredRedirects / mergeRedirects", () => {
  it("the shared client needs both callbacks, a per-account client only the multi-account one", () => {
    expect(m.requiredRedirects(`${BASE}/`, "shared")).toEqual([`${BASE}/api/auth/google/oauth/callback`, `${BASE}/auth/google/callback`]);
    expect(m.requiredRedirects(BASE, "account")).toEqual([`${BASE}/api/auth/google/oauth/callback`]);
  });

  it("merges without duplicates and keeps the existing order", () => {
    expect(m.mergeRedirects(["https://a/cb", "https://b/cb"], ["https://b/cb", "https://c/cb"])).toEqual(["https://a/cb", "https://b/cb", "https://c/cb"]);
  });
});

describe("classifyAuthProbe (authorization endpoint)", () => {
  it("a redirect to the sign-in page means the redirect URI is registered", () => {
    expect(m.classifyAuthProbe(302, "https://accounts.google.com/v3/signin/identifier?opparams=x").ok).toBe(true);
  });

  it("decodes redirect_uri_mismatch from the authError payload", () => {
    const loc = `https://accounts.google.com/signin/oauth/error?authError=${b64("\n\x15redirect_uri_mismatch\x12\x1fYou can't sign in to this app")}&client_id=x`;
    expect(m.classifyAuthProbe(302, loc)).toMatchObject({ ok: false, code: "redirect_uri_mismatch" });
  });

  it("decodes invalid_client", () => {
    const loc = `/signin/oauth/error?authError=${b64("\n\x0einvalid_client\x12\x1aThe OAuth client was not found.")}`;
    expect(m.classifyAuthProbe(302, loc)).toMatchObject({ ok: false, code: "invalid_client" });
  });

  it("a non-redirect answer is not a pass", () => {
    expect(m.classifyAuthProbe(400, null, "Error 400: redirect_uri_mismatch")).toMatchObject({ ok: false, code: "redirect_uri_mismatch" });
    expect(m.classifyAuthProbe(200, null, "<html>")).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("classifyTokenProbe (token endpoint, dummy code)", () => {
  it("invalid_grant means the id and secret are valid", () => {
    expect(m.classifyTokenProbe({ error: "invalid_grant", error_description: "Malformed auth code." }).ok).toBe(true);
  });

  it("names a wrong secret and an unknown client", () => {
    expect(m.classifyTokenProbe({ error: "invalid_client", error_description: "The provided client secret is invalid." }).code).toBe("bad_secret");
    expect(m.classifyTokenProbe({ error: "invalid_client", error_description: "The OAuth client was not found." }).code).toBe("unknown_client");
  });
});

describe("secretNames", () => {
  it("matches the Worker's secret names (auth/oauth-google.ts)", () => {
    expect(m.secretNames("shared")).toEqual({ id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" });
    expect(m.secretNames("account", "justin@126colby.com")).toEqual({
      id: "GOOGLE_OAUTH_CLIENT_ID_JUSTIN_126COLBY_COM",
      secret: "GOOGLE_OAUTH_CLIENT_SECRET_JUSTIN_126COLBY_COM",
    });
  });
});

describe("consoleUrls", () => {
  it("points at the client's Console page in its project", () => {
    expect(m.consoleUrls("abc.apps.googleusercontent.com", "p1")[0]).toBe("https://console.cloud.google.com/auth/clients/abc.apps.googleusercontent.com?project=p1");
  });
});
