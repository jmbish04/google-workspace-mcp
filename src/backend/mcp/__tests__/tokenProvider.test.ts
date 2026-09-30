import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const oauth = vi.hoisted(() => ({ hasOAuthRefreshToken: vi.fn(), getOAuthAccessToken: vi.fn() }));
vi.mock("../../auth/oauth-google", () => oauth);
vi.mock("../../utils/secrets", () => ({ getSecret: async (_env: unknown, name: string) => (name === "GOOGLE_CLIENT_ID" ? "cid" : "csecret") }));

import { getAccessToken, saveUser } from "../tokenProvider";

function kvMock() {
  const m = new Map<string, string>();
  return { store: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}

let env: Env;
const tokenCalls: number[] = [];
function googleAnswers(status: number, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toBe("https://oauth2.googleapis.com/token");
    tokenCalls.push(status);
    return new Response(JSON.stringify(body), { status });
  }));
}

beforeEach(async () => {
  env = { SESSIONS: kvMock() } as unknown as Env;
  tokenCalls.length = 0;
  oauth.hasOAuthRefreshToken.mockReset();
  oauth.getOAuthAccessToken.mockReset();
  await saveUser(env, { sub: "sub-justin", email: "Justin@126colby.com", refreshToken: "stale", scopes: [], updatedAt: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe("getAccessToken for a signed-in sub", () => {
  it("falls back to the account's email OAuth credentials when Google rejects the sub's refresh token (400)", async () => {
    googleAnswers(400, { error: "invalid_grant" });
    oauth.hasOAuthRefreshToken.mockResolvedValue(true);
    oauth.getOAuthAccessToken.mockResolvedValue("email-token");
    await (env.SESSIONS as unknown as ReturnType<typeof kvMock>).put("gwstok:sub-justin", JSON.stringify({ access_token: "old", exp: 0 }));
    expect(await getAccessToken(env, "sub-justin")).toBe("email-token");
    expect(oauth.hasOAuthRefreshToken).toHaveBeenCalledWith(env, "justin@126colby.com");
    expect(oauth.getOAuthAccessToken).toHaveBeenCalledWith(env, "justin@126colby.com", expect.any(Array));
    expect((env.SESSIONS as unknown as ReturnType<typeof kvMock>).store.has("gwstok:sub-justin")).toBe(false);
  });

  it("still fails when the account has no email OAuth credentials to fall back to", async () => {
    googleAnswers(400, { error: "invalid_grant" });
    oauth.hasOAuthRefreshToken.mockResolvedValue(false);
    await expect(getAccessToken(env, "sub-justin")).rejects.toThrow("Token refresh failed: 400");
    expect(oauth.getOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("does not paper over a Google outage (5xx is not a stale token)", async () => {
    googleAnswers(503);
    oauth.hasOAuthRefreshToken.mockResolvedValue(true);
    await expect(getAccessToken(env, "sub-justin")).rejects.toThrow("Token refresh failed: 503");
    expect(oauth.getOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("uses the sub's own token when its refresh succeeds", async () => {
    googleAnswers(200, { access_token: "fresh", expires_in: 3600 });
    expect(await getAccessToken(env, "sub-justin")).toBe("fresh");
    expect(oauth.hasOAuthRefreshToken).not.toHaveBeenCalled();
  });
});
