import { describe, it, expect, vi, afterEach } from "vitest";

import { extractChatText, guardianRun } from "../guardian-ai";

describe("extractChatText", () => {
  it("reads OpenAI-compatible responses", () => {
    expect(extractChatText({ choices: [{ message: { content: "clean, professional" } }] })).toBe("clean, professional");
  });
  it("reads native Ollama /api/chat responses", () => {
    expect(extractChatText({ message: { content: "crowded header" } })).toBe("crowded header");
  });
  it("reads native Ollama /api/generate responses", () => {
    expect(extractChatText({ response: "playful style" })).toBe("playful style");
  });
  it("returns '' for an unrecognized shape", () => {
    expect(extractChatText({ nope: true })).toBe("");
  });
});

describe("guardianRun", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null (never throws) when the token is absent", async () => {
    const env = {} as any; // no WORKER_API_KEY
    expect(await guardianRun(env, { provider: "ollama", model: "m", input: {} })).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const env = { WORKER_API_KEY: "tok" } as any;
    expect(await guardianRun(env, { provider: "ollama", model: "m", input: {} })).toBeNull();
  });

  it("posts to /api/ai-router/run with a bearer token and returns the parsed result", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ body: { response: "ok" } }), { status: 200 }));
    const env = { WORKER_API_KEY: "tok" } as any;
    const out = await guardianRun(env, { provider: "ollama", model: "qwen3.5", input: { messages: [] } });
    expect(out?.body).toEqual({ response: "ok" });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/ai-router/run");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });
});
