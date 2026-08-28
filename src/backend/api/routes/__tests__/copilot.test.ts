import { describe, it, expect } from "vitest";

import { copilotRouter } from "../copilot";

const env: any = { WORKER_API_KEY: "tok" };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  copilotRouter.request(
    "/chat",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
    env,
  );

describe("POST /api/copilot/chat", () => {
  it("401s without a bearer token", async () => {
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("401s with the wrong token", async () => {
    const res = await post({ messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("400s when messages[] is missing/empty (authorized)", async () => {
    const res = await post({ messages: [] }, { authorization: "Bearer tok" });
    expect(res.status).toBe(400);
  });

  it("OPTIONS preflight returns CORS headers", async () => {
    const res = await copilotRouter.request("/chat", { method: "OPTIONS" }, env);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("POST /api/copilot/token", () => {
  it("401s without the worker key", async () => {
    const res = await copilotRouter.request("/token", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(401);
  });
  it("issues a token (KV-backed) with the worker key", async () => {
    const store = new Map<string, string>();
    const kvEnv: any = { WORKER_API_KEY: "tok", SESSIONS: { put: async (k: string, v: string) => void store.set(k, v), get: async (k: string) => store.get(k) ?? null } };
    const res = await copilotRouter.request(
      "/token",
      { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ account: "workspace", fileId: "1ABC", hostType: "doc" }) },
      kvEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.length).toBeGreaterThan(20);
    expect(store.has("copilottok:" + body.token)).toBe(true);
  });
});

describe("GET /api/copilot/page", () => {
  it("serves the copilot HTML", async () => {
    const res = await copilotRouter.request("/page", {}, env);
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "")).toContain("text/html");
    expect(await res.text()).toContain("/api/copilot/chat");
  });
});
