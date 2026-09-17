import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleOAuth, completeMcpAuthorize, resolveAccessToken } from "../oauth";

function kvMock() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

let env: Env;
beforeEach(() => {
  env = {
    SESSIONS: kvMock(),
    GOOGLE_CLIENT_ID: "gcid",
    PUBLIC_BASE_URL: "https://mcp.example.dev",
    WORKER_API_KEY: "test-key-0123456789abcdef",
  } as unknown as Env;
});

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://mcp.example.dev${path}`, init);
}

/** PKCE S256 challenge for a verifier (same transform as the server). */
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The pending-request id the authorize page carries in its passcode form. */
function reqIdFrom(page: string): string {
  const m = page.match(/name="req" value="([^"]+)"/);
  if (!m) throw new Error("authorize page has no req field");
  return m[1];
}

function formPost(path: string, fields: Record<string, string>): Request {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("MCP OAuth discovery", () => {
  it("protected-resource metadata points at the MCP resource + auth server", async () => {
    const res = (await handleOAuth(req("/.well-known/oauth-protected-resource"), env))!;
    const body = (await res.json()) as any;
    expect(body.resource).toBe("https://mcp.example.dev/mcp");
    expect(body.authorization_servers).toEqual(["https://mcp.example.dev"]);
  });

  it("authorization-server metadata exposes the required RFC 8414 fields", async () => {
    const res = (await (await handleOAuth(req("/.well-known/oauth-authorization-server"), env))!.json()) as any;
    expect(res.issuer).toBe("https://mcp.example.dev");
    expect(res.authorization_endpoint).toBe("https://mcp.example.dev/authorize");
    expect(res.token_endpoint).toBe("https://mcp.example.dev/token");
    expect(res.registration_endpoint).toBe("https://mcp.example.dev/register");
    expect(res.code_challenge_methods_supported).toEqual(["S256"]);
    expect(res.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
  });
});

describe("MCP OAuth full flow", () => {
  async function registerClient(redirectUri: string): Promise<string> {
    const res = await handleOAuth(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }),
      }),
      env,
    );
    expect(res!.status).toBe(201);
    const body = (await res!.json()) as any;
    expect(body.client_id).toMatch(/^client_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    return body.client_id;
  }

  it("register → authorize → (google) → token → resolve, with PKCE", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const clientId = await registerClient(redirectUri);

    const verifier = "verifier-0123456789-0123456789-0123456789-abc";
    const challenge = await challengeFor(verifier);

    // /authorize → 302 to Google, stores a pending request
    const authRes = await handleOAuth(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256&state=client-state-xyz`,
      ),
      env,
    );
    expect(authRes!.status).toBe(200);
    const page = await authRes!.text();
    expect(page).toContain("accounts.google.com");
    expect(page).toContain("state=mcp%3A");
    const reqId = reqIdFrom(page);

    // Google callback would call this after authenticating the user
    const clientRedirect = await completeMcpAuthorize(env, reqId, "sub-999");
    expect(clientRedirect).toBeTruthy();
    const cbUrl = new URL(clientRedirect!);
    expect(cbUrl.origin + cbUrl.pathname).toBe(redirectUri);
    expect(cbUrl.searchParams.get("state")).toBe("client-state-xyz");
    const code = cbUrl.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // /token exchange with the matching verifier
    const tokRes = await handleOAuth(
      req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      }),
      env,
    );
    expect(tokRes!.status).toBe(200);
    const tok = (await tokRes!.json()) as any;
    expect(tok.token_type).toBe("Bearer");
    expect(tok.access_token).toMatch(/^at_/);
    expect(tok.refresh_token).toMatch(/^rt_/);

    // The access token resolves to the Google sub
    expect(await resolveAccessToken(env, tok.access_token)).toBe("sub-999");

    // refresh_token grant issues a fresh access token
    const refreshRes = await handleOAuth(
      req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }).toString(),
      }),
      env,
    );
    const refreshed = (await refreshRes!.json()) as any;
    expect(refreshed.access_token).toMatch(/^at_/);
    expect(await resolveAccessToken(env, refreshed.access_token)).toBe("sub-999");
  });

  it("rejects a token exchange with a wrong PKCE verifier", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const clientId = await registerClient(redirectUri);
    const challenge = await challengeFor("the-real-verifier-aaaaaaaaaaaaaaaaaaaaaaaa");

    const authRes = await handleOAuth(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256&state=s`,
      ),
      env,
    );
    const reqId = reqIdFrom(await authRes!.text());
    const code = new URL((await completeMcpAuthorize(env, reqId, "sub-1"))!).searchParams.get("code")!;

    const tokRes = await handleOAuth(
      req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: "WRONG-verifier-bbbbbbbbbbbbbbbbbbbbbbbb",
        }).toString(),
      }),
      env,
    );
    expect(tokRes!.status).toBe(400);
    expect(((await tokRes!.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a refresh_token replayed by a different client", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const clientA = await registerClient(redirectUri);
    const clientB = await registerClient(redirectUri);
    const verifier = "verifier-cccccccccccccccccccccccccccccccccccccccc";
    const challenge = await challengeFor(verifier);
    const authRes = await handleOAuth(
      req(
        `/authorize?response_type=code&client_id=${clientA}&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256&state=s`,
      ),
      env,
    );
    const reqId = reqIdFrom(await authRes!.text());
    const code = new URL((await completeMcpAuthorize(env, reqId, "sub-1"))!).searchParams.get("code")!;
    const tok = (await (await handleOAuth(
      req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientA, code_verifier: verifier }).toString(),
      }),
      env,
    ))!.json()) as any;
    // clientB tries to use clientA's refresh token
    const bad = (await handleOAuth(
      req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientB }).toString(),
      }),
      env,
    ))!;
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects /authorize with an unregistered redirect_uri", async () => {
    const clientId = await registerClient("https://claude.ai/api/mcp/auth_callback");
    const res = await handleOAuth(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/steal")}` +
          `&code_challenge=abc&code_challenge_method=S256&state=s`,
      ),
      env,
    );
    // Must NOT redirect to the attacker URI — render an error instead.
    expect(res!.status).toBe(400);
  });

  it("returns null for non-OAuth paths (falls through)", async () => {
    expect(await handleOAuth(req("/gws"), env)).toBeNull();
  });
});

describe("MCP OAuth passcode door", () => {
  const cb = "https://claude.ai/api/mcp/auth_callback";
  const verifier = "verifier-passcode-0123456789-0123456789-0123";

  async function openPage(redirectUri = cb): Promise<{ clientId: string; res: Response; page: string }> {
    const reg = await handleOAuth(
      req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
      env,
    );
    const clientId = ((await reg!.json()) as any).client_id as string;
    const res = (await handleOAuth(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&code_challenge=${await challengeFor(verifier)}&code_challenge_method=S256&state=s1`,
      ),
      env,
    ))!;
    return { clientId, res, page: await res.text() };
  }

  it("page names the receiving host, says Passcode, never names the secret, refuses framing", async () => {
    const { res, page } = await openPage();
    expect(res.status).toBe(200);
    expect(page).toContain("Enter the passcode to connect claude.ai");
    expect(page).toContain("Passcode");
    expect(page).not.toMatch(/WORKER_API_KEY/i);
    expect(page).not.toContain("test-key-0123456789abcdef");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("wrong passcode → 401 with no redirect; the pending request survives for a retry", async () => {
    const { page } = await openPage();
    const reqId = reqIdFrom(page);
    const bad = (await handleOAuth(formPost("/authorize", { req: reqId, passcode: "wrong" }), env))!;
    expect(bad.status).toBe(401);
    expect(bad.headers.get("location")).toBeNull();
    const badPage = await bad.text();
    expect(badPage).toContain("That passcode is not right.");
    expect(badPage).not.toMatch(/WORKER_API_KEY/i);
    const ok = (await handleOAuth(formPost("/authorize", { req: reqId, passcode: "test-key-0123456789abcdef" }), env))!;
    expect(ok.status).toBe(303);
  });

  it("right passcode → 303 code+state → 1-year token bound to the default identity", async () => {
    const { clientId, page } = await openPage();
    const ok = (await handleOAuth(
      formPost("/authorize", { req: reqIdFrom(page), passcode: "test-key-0123456789abcdef" }),
      env,
    ))!;
    expect(ok.status).toBe(303);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(cb);
    expect(loc.searchParams.get("state")).toBe("s1");
    const code = loc.searchParams.get("code")!;

    const tokRes = (await handleOAuth(
      formPost("/token", { grant_type: "authorization_code", code, redirect_uri: cb, client_id: clientId, code_verifier: verifier }),
      env,
    ))!;
    expect(tokRes.status).toBe(200);
    const tok = (await tokRes.json()) as any;
    expect(tok.expires_in).toBe(31536000);
    expect(await resolveAccessToken(env, tok.access_token)).toBe("justin@126colby.com");
  });

  it("POST /authorize with an unknown request id → 400", async () => {
    const res = (await handleOAuth(formPost("/authorize", { req: "nope", passcode: "test-key-0123456789abcdef" }), env))!;
    expect(res.status).toBe(400);
  });

  it("registration allows http only to loopback, including [::1]", async () => {
    const reg = (uri: string) =>
      handleOAuth(
        req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) }),
        env,
      );
    expect((await reg("http://evil.example/cb"))!.status).toBe(400);
    expect((await reg("http://localhost:33418/cb"))!.status).toBe(201);
    expect((await reg("http://[::1]:33418/cb"))!.status).toBe(201);
  });

  it("the authorize page is sent with nosniff", async () => {
    const { res } = await openPage();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("a replayed req after a successful authorize is refused (single use)", async () => {
    const { page } = await openPage();
    const reqId = reqIdFrom(page);
    const first = (await handleOAuth(formPost("/authorize", { req: reqId, passcode: "test-key-0123456789abcdef" }), env))!;
    expect(first.status).toBe(303);
    const replay = (await handleOAuth(formPost("/authorize", { req: reqId, passcode: "test-key-0123456789abcdef" }), env))!;
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });

  it("logs a warning on a failed passcode, naming neither the credential nor the submitted value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { page } = await openPage();
    await handleOAuth(formPost("/authorize", { req: reqIdFrom(page), passcode: "hunter2" }), env);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().map((a) => JSON.stringify(a)).join(" ");
    expect(logged).not.toMatch(/WORKER_API_KEY/i);
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("test-key-0123456789abcdef");
    warn.mockRestore();
  });

  it("refuses the passcode for a redirect host that is not claude.ai or loopback, and issues nothing", async () => {
    const evil = "https://evil.example/cb";
    const { page } = await openPage(evil);
    const res = (await handleOAuth(formPost("/authorize", { req: reqIdFrom(page), passcode: "test-key-0123456789abcdef" }), env))!;
    expect(res.status).not.toBe(303);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain("Sign in with Google instead.");
    expect(body).not.toMatch(/WORKER_API_KEY/i);
    expect(body).not.toContain("test-key-0123456789abcdef");
    // Nothing was minted: no authorization code, no token.
    const keys = [...(env.SESSIONS as any).store.keys()] as string[];
    expect(keys.some((k) => k.startsWith("oauthcode:") || k.startsWith("oauthtok:"))).toBe(false);
  });

  it("still accepts the passcode for claude.ai, a claude.ai subdomain and loopback", async () => {
    for (const uri of ["https://claude.ai/api/mcp/auth_callback", "https://foo.claude.ai/cb", "http://localhost:33418/cb", "http://127.0.0.1:33418/cb", "http://[::1]:33418/cb"]) {
      const { page } = await openPage(uri);
      const res = (await handleOAuth(formPost("/authorize", { req: reqIdFrom(page), passcode: "test-key-0123456789abcdef" }), env))!;
      expect(`${uri} → ${res.status}`).toBe(`${uri} → 303`);
      expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    }
  });

  it("a lookalike host is not treated as a claude.ai subdomain", async () => {
    const { page } = await openPage("https://notclaude.ai/cb");
    const res = (await handleOAuth(formPost("/authorize", { req: reqIdFrom(page), passcode: "test-key-0123456789abcdef" }), env))!;
    expect(res.status).not.toBe(303);
  });

  it("authorize without PKCE, or with plain PKCE, is refused", async () => {
    const reg = await handleOAuth(
      req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [cb] }) }),
      env,
    );
    const clientId = ((await reg!.json()) as any).client_id as string;
    const base = `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(cb)}&state=s`;
    for (const extra of ["", "&code_challenge=abc&code_challenge_method=plain"]) {
      const res = (await handleOAuth(req(base + extra), env))!;
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    }
  });
});
