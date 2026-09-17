import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSessionCookie } from "@/backend/lib/cookies";
import { handleMcpRequest } from "../server";

// Capture the resolved sub without running a real tool or touching D1.
vi.mock("../tool-runner", () => ({
  runTool: vi.fn(async (_tool: unknown, ctx: { sub: string }) => ({ result: { sub: ctx.sub } })),
}));
vi.mock("../logging", () => ({
  logOperation: vi.fn(async () => {}),
  logAssetTouch: vi.fn(async () => {}),
}));

// ponytail: SESSIONS is a KV binding. getCookieSigningKey reads the
// COOKIE_SIGNING_KEY key; the OAuth token lookup reads oauthtok:* — return the
// signing key only for its key, null otherwise (a naive "return X for all keys"
// mock breaks resolveAccessToken's JSON.parse).
const env = {
  SESSIONS: {
    get: async (k: string) => (k === "COOKIE_SIGNING_KEY" ? "test-key-please-change" : null),
  },
} as unknown as Env;

const ctx = {} as ExecutionContext;

async function bearerFor(sub: string): Promise<string> {
  const setCookie = await createSessionCookie(env, { sub });
  const raw = setCookie.split(";")[0]; // "cr_session=payload.sig"
  return raw.slice("cr_session=".length);
}

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** An authenticated /mcp request (session-cookie value as bearer). */
async function authed(body: unknown, sub = "s1"): Promise<Request> {
  return rpc(body, { authorization: `Bearer ${await bearerFor(sub)}` });
}

type RpcBody = { result?: any; error?: { code: number; message: string } };

async function rpcJson(res: Response): Promise<RpcBody> {
  return (await res.json()) as RpcBody;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("handleMcpRequest", () => {
  it("unauthenticated POST returns HTTP 401 with a WWW-Authenticate resource pointer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }), env, ctx);
    expect(res.status).toBe(401);
    const www = res.headers.get("WWW-Authenticate") ?? "";
    expect(www).toContain("Bearer");
    expect(www).toContain("resource_metadata=");
    expect(www).toContain("/.well-known/oauth-protected-resource");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await handleMcpRequest(
      new Request("https://example.workers.dev/mcp", { method: "OPTIONS" }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("initialize (authed) returns protocolVersion + serverInfo", async () => {
    const res = await handleMcpRequest(await authed({ jsonrpc: "2.0", id: 1, method: "initialize" }), env, ctx);
    expect(res.status).toBe(200);
    const body = await rpcJson(res);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo).toEqual({ name: "google-workspace-mcp", version: "1.0.0" });
  });

  it("tools/list (authed) returns only the code-mode catalog with JSON Schema input/output shapes", async () => {
    const res = await handleMcpRequest(await authed({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, ctx);
    expect(res.status).toBe(200);
    const body = await rpcJson(res);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["code_mode_search", "code_mode_run"]);
    for (const t of body.result.tools) {
      expect(typeof t.inputSchema).toBe("object");
      expect(t.inputSchema).not.toBeNull();
      expect(typeof t.outputSchema).toBe("object");
      expect(t.outputSchema).not.toBeNull();
    }
  });

  it("tools/call with auth but an unknown tool name returns -32602 and never hits the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleMcpRequest(
      await authed({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "not_a_real_tool", arguments: {} } }),
      env,
      ctx,
    );
    const body = await rpcJson(res);
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32602);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tools/call for a non-exposed tool (gmail_send) returns -32602 — code-mode surface only", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleMcpRequest(
      await authed({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gmail_send", arguments: {} } }),
      env,
      ctx,
    );
    const body = await rpcJson(res);
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32602);
    expect(body.error!.message).toContain("Unknown tool: gmail_send");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifications/* (authed) return HTTP 202 with no JSON-RPC body", async () => {
    const res = await handleMcpRequest(await authed({ jsonrpc: "2.0", method: "notifications/initialized" }), env, ctx);
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("unknown method (authed) returns -32601", async () => {
    const res = await handleMcpRequest(await authed({ jsonrpc: "2.0", id: 6, method: "bogus/method" }), env, ctx);
    const body = await rpcJson(res);
    expect(body.error!.code).toBe(-32601);
  });

  it("rejects non-POST requests with 405", async () => {
    const res = await handleMcpRequest(new Request("https://example.workers.dev/mcp", { method: "GET" }), env, ctx);
    expect(res.status).toBe(405);
  });

  it("a request missing `method` (authed) degrades to -32600 instead of throwing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await handleMcpRequest(await authed({ jsonrpc: "2.0", id: 1 }), env, ctx);
    expect(res.status).toBe(200);
    const body = await rpcJson(res);
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32600);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-JSON body degrades to a parse error before auth", async () => {
    const res = await handleMcpRequest(
      new Request("https://example.workers.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      env,
      ctx,
    );
    expect([400, 200]).toContain(res.status);
    const body = await rpcJson(res);
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32700);
  });
});

const KEY = "test-key-0123456789abcdef";

function envWith(vars: Record<string, unknown> = {}, kv: Record<string, string> = {}): Env {
  return {
    SESSIONS: {
      get: async (k: string) => (k === "COOKIE_SIGNING_KEY" ? "test-key-please-change" : (kv[k] ?? null)),
    },
    WORKER_API_KEY: KEY,
    GOOGLE_WORKSPACE_ACCOUNT_EMAIL: "",
    GOOGLE_USER_TO_IMPERSONATE: "",
    ...vars,
  } as unknown as Env;
}

const runCall = {
  jsonrpc: "2.0",
  id: 9,
  method: "tools/call",
  params: { name: "code_mode_run", arguments: { code: "return 1" } },
};

async function subOf(res: Response): Promise<string> {
  const body = await rpcJson(res);
  return JSON.parse(body.result.content[0].text).sub;
}

describe("/mcp auth doors", () => {
  it("Bearer WORKER_API_KEY resolves to the default Workspace identity (empty vars fall back)", async () => {
    const res = await handleMcpRequest(rpc(runCall, { authorization: `Bearer ${KEY}` }), envWith(), ctx);
    expect(res.status).toBe(200);
    expect(await subOf(res)).toBe("justin@126colby.com");
  });

  it("default identity prefers GOOGLE_WORKSPACE_ACCOUNT_EMAIL, then GOOGLE_USER_TO_IMPERSONATE", async () => {
    const a = await handleMcpRequest(
      rpc(runCall, { authorization: `Bearer ${KEY}` }),
      envWith({ GOOGLE_WORKSPACE_ACCOUNT_EMAIL: "Ops@126colby.com", GOOGLE_USER_TO_IMPERSONATE: "x@126colby.com" }),
      ctx,
    );
    expect(await subOf(a)).toBe("ops@126colby.com");
    const b = await handleMcpRequest(
      rpc(runCall, { authorization: `Bearer ${KEY}` }),
      envWith({ GOOGLE_USER_TO_IMPERSONATE: "x@126colby.com" }),
      ctx,
    );
    expect(await subOf(b)).toBe("x@126colby.com");
  });

  it("a wrong key is HTTP 401 with WWW-Authenticate and never names the secret", async () => {
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer not-the-key" }),
      envWith(),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://example.workers.dev/.well-known/oauth-protected-resource"',
    );
    expect(await res.text()).not.toMatch(/WORKER_API_KEY/i);
  });

  it("a Google-sign-in OAuth access token still resolves to its Google sub", async () => {
    const env2 = envWith({}, { "oauthtok:at_google": JSON.stringify({ sub: "google-sub-1", clientId: "c1" }) });
    const res = await handleMcpRequest(rpc(runCall, { authorization: "Bearer at_google" }), env2, ctx);
    expect(res.status).toBe(200);
    expect(await subOf(res)).toBe("google-sub-1");
  });
});
