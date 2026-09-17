import { describe, it, expect } from "vitest";

import {
  accountSecretSuffix,
  getGoogleOAuthClientIdForAccount,
  getSeedRefreshTokenForAccount,
  getWorkerApiKey,
  hasDedicatedOAuthClient,
} from "../secrets";

describe("getWorkerApiKey", () => {
  it("awaits the Secret Store binding's .get()", async () => {
    const env = { WORKER_API_KEY: { get: async () => "from-secret-store" } } as unknown as Env;
    expect(await getWorkerApiKey(env)).toBe("from-secret-store");
  });

  it("reads a plain string binding (local/dev fallback)", async () => {
    expect(await getWorkerApiKey({ WORKER_API_KEY: "plain" } as unknown as Env)).toBe("plain");
  });

  it("is undefined when nothing is configured, so callers fail closed", async () => {
    expect(await getWorkerApiKey({} as unknown as Env)).toBeUndefined();
  });

  it("propagates a Secret Store failure — callers decide whether to fail closed", async () => {
    const env = {
      WORKER_API_KEY: {
        get: async () => {
          throw new Error("secrets store unavailable");
        },
      },
    } as unknown as Env;
    await expect(getWorkerApiKey(env)).rejects.toThrow("secrets store unavailable");
  });
});

describe("accountSecretSuffix", () => {
  it("normalizes an email to an uppercase underscore suffix", () => {
    expect(accountSecretSuffix("justin@126colby.com")).toBe("JUSTIN_126COLBY_COM");
  });
  it("collapses runs of non-alphanumerics and trims edges", () => {
    expect(accountSecretSuffix("  a.b+tag@x-y.co ")).toBe("A_B_TAG_X_Y_CO");
  });
});

describe("per-account secret resolution", () => {
  const env = {
    GOOGLE_OAUTH_CLIENT_ID_JUSTIN_126COLBY_COM: "justin-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET_JUSTIN_126COLBY_COM: "justin-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN_JUSTIN_126COLBY_COM: "justin-refresh",
    GOOGLE_CLIENT_ID: "shared-client-id",
    GOOGLE_CLIENT_SECRET: "shared-secret",
  } as unknown as Env;

  it("prefers the per-account client id when configured", async () => {
    expect(await getGoogleOAuthClientIdForAccount(env, "justin@126colby.com")).toBe("justin-client-id");
  });
  it("falls back to the shared client id for other accounts", async () => {
    expect(await getGoogleOAuthClientIdForAccount(env, "someone@else.com")).toBe("shared-client-id");
  });
  it("reads the per-account seed refresh token", async () => {
    expect(await getSeedRefreshTokenForAccount(env, "justin@126colby.com")).toBe("justin-refresh");
    expect(await getSeedRefreshTokenForAccount(env, "someone@else.com")).toBeUndefined();
  });
  it("detects a dedicated OAuth client", async () => {
    expect(await hasDedicatedOAuthClient(env, "justin@126colby.com")).toBe(true);
    expect(await hasDedicatedOAuthClient(env, "someone@else.com")).toBe(false);
  });
});
