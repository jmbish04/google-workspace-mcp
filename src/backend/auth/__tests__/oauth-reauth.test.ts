/**
 * @fileoverview Regression guards for the Workspace reauth (`invalid_rapt`)
 * failure that was expiring `justin@126colby.com` on a schedule.
 *
 * Every assertion here is the inverse of something that was true in production
 * on 2026-09-28, so each one fails if the fix is reverted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ALL_GOOGLE_SCOPES,
  REAUTH_TRIGGERING_SCOPES,
  isReauthExposed,
} from "@/backend/lib/google-auth";

const markStatus = vi.fn<(email: string, status: string) => void>();

// D1 is stubbed: these tests are about the OAuth control flow, not Drizzle.
vi.mock("@/backend/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ status: "active" }] }) }),
    }),
    update: () => ({
      set: (v: { status: string }) => ({
        where: async () => markStatus("*", v.status),
      }),
    }),
  }),
}));
vi.mock("@db/schemas", () => ({ googleAccounts: { email: "email", status: "status" } }));
vi.mock("@/backend/utils/secrets", () => ({
  getGoogleOAuthClientId: async () => "client",
  getGoogleOAuthClientIdForAccount: async () => "client",
  getGoogleOAuthClientSecretForAccount: async () => "secret",
  getSeedPersonalRefreshToken: async () => undefined,
  getSeedRefreshTokenForAccount: async () => undefined,
}));

/** Minimal Env with an in-memory SESSIONS KV. */
function makeEnv(kv: Record<string, string>) {
  return {
    GOOGLE_OAUTH_REDIRECT_URI: "https://example.test/cb",
    SESSIONS: {
      get: async (k: string) => kv[k] ?? null,
      put: async (k: string, v: string) => void (kv[k] = v),
      delete: async (k: string) => void delete kv[k],
    },
  } as unknown as Env;
}

describe("Google Cloud session control (invalid_rapt) guards", () => {
  beforeEach(() => {
    markStatus.mockClear();
    vi.restoreAllMocks();
  });

  it("requests NO Google Cloud scope — a Cloud scope puts the grant under Workspace reauth policy", () => {
    for (const bad of REAUTH_TRIGGERING_SCOPES) {
      expect(ALL_GOOGLE_SCOPES).not.toContain(bad);
    }
    // ...while still covering everything the worker actually calls.
    expect(ALL_GOOGLE_SCOPES).toEqual(
      expect.arrayContaining([
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/contacts",
        "https://www.googleapis.com/auth/directory.readonly",
        "https://www.googleapis.com/auth/forms.body",
        "https://www.googleapis.com/auth/script.projects",
      ]),
    );
  });

  it("flags a Cloud-scoped grant as reauth-exposed and a clean one as not", () => {
    expect(isReauthExposed(["https://www.googleapis.com/auth/cloud-platform"])).toBe(true);
    expect(isReauthExposed(ALL_GOOGLE_SCOPES)).toBe(false);
    expect(isReauthExposed([])).toBe(false);
    expect(isReauthExposed(null)).toBe(false);
  });

  it("builds a consent URL with include_granted_scopes=false so Cloud scopes cannot be merged back", async () => {
    const { buildConsentUrl } = await import("../oauth-google");
    const url = new URL(await buildConsentUrl(makeEnv({}), "state-1", "justin@126colby.com"));
    // "true" is what silently re-attached cloud-platform on every re-consent.
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("scope")).not.toContain("cloud-platform");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("marks the account needs_reauth and explains invalid_rapt when Google rejects the refresh", async () => {
    const { getOAuthAccessToken, NEEDS_REAUTH } = await import("../oauth-google");
    const env = makeEnv({
      "google:oauth:justin@126colby.com:refresh_token": "rt-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_subtype: "invalid_rapt" }),
          { status: 400 },
        ),
      ),
    );

    await expect(
      getOAuthAccessToken(env, "justin@126colby.com", ALL_GOOGLE_SCOPES),
    ).rejects.toThrow(/Google Cloud session control/);
    expect(markStatus).toHaveBeenCalledWith("*", NEEDS_REAUTH);
  });

  it("does not silently re-seed a refresh token for a non-active account", async () => {
    // A revoked/needs_reauth row must not be resurrected from the seed secret —
    // that is how the broken Cloud-scoped grant kept coming back.
    vi.doMock("@/backend/db", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [{ status: "needs_reauth" }] }) }),
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      }),
    }));
    vi.doMock("@/backend/utils/secrets", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getSeedRefreshTokenForAccount: async () => "seed-rt",
    }));
    vi.resetModules();
    const { hasOAuthRefreshToken } = await import("../oauth-google");
    expect(await hasOAuthRefreshToken(makeEnv({}), "justin@126colby.com")).toBe(false);
    vi.doUnmock("@/backend/db");
    vi.doUnmock("@/backend/utils/secrets");
    vi.resetModules();
  });
});
