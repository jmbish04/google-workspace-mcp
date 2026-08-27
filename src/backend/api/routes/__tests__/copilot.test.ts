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
