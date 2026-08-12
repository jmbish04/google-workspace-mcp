import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAccessToken, saveUser, isConsumerGoogleAccount } from "../tokenProvider";

function kvMock() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

describe("tokenProvider", () => {
  let env: any;
  beforeEach(() => {
    env = {
      SESSIONS: kvMock(),
      GOOGLE_CLIENT_ID: { get: async () => "cid" }, // secrets-store style
      GOOGLE_CLIENT_SECRET: { get: async () => "secret" },
    };
  });

  it("refreshes and caches an access token when none is cached", async () => {
    await saveUser(env, { sub: "s1", refreshToken: "rt", scopes: [], updatedAt: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at-123", expires_in: 3600 }), { status: 200 }),
    );
    const tok = await getAccessToken(env, "s1");
    expect(tok).toBe("at-123");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await env.SESSIONS.get("gwstok:s1")).toContain("at-123");

    // second call is served from cache (no new fetch)
    const tok2 = await getAccessToken(env, "s1");
    expect(tok2).toBe("at-123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies consumer Google mailboxes", () => {
    expect(isConsumerGoogleAccount("jmbish04@gmail.com")).toBe(true);
    expect(isConsumerGoogleAccount("Foo@GoogleMail.com")).toBe(true);
    expect(isConsumerGoogleAccount("justin@126colby.com")).toBe(false);
  });

  it("never attempts DWD for a consumer account with no stored token — actionable login error", async () => {
    // No refresh token stored for this gmail.com account. The OAuth-only branch
    // throws a login-URL error; the DWD path would throw a different one, so this
    // message proves we did NOT fall through to domain-wide delegation.
    await expect(getAccessToken(env, "dwd:jmbish04@gmail.com")).rejects.toThrow(
      /log in at \/api\/auth\/google\/oauth\/start\?label=/,
    );
  });

  it("uses the stored OAuth token for a consumer account when present (no DWD)", async () => {
    await env.SESSIONS.put("google:oauth:jmbish04@gmail.com:refresh_token", "rt-consumer");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "at-oauth", expires_in: 3600 }), { status: 200 }),
    );
    const tok = await getAccessToken(env, "dwd:jmbish04@gmail.com");
    expect(tok).toBe("at-oauth");
    expect(fetchMock).toHaveBeenCalled();
  });
});
