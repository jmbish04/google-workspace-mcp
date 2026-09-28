/**
 * @fileoverview Guard for the Workspace Events subscription listing.
 *
 * Measured 2026-09-28: with 253 subscriptions on one account, the unpaged call
 * returned exactly 100 and reported no truncation. A caller scanning that list
 * for a target would conclude "not present" from a page boundary — an absence
 * that is a fact about the listing, not about Google.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const googleJson = vi.fn();
vi.mock("../googleClient", () => ({
  googleJson: (...args: unknown[]) => googleJson(...args),
  googleFetch: vi.fn(),
}));

const { WorkspaceEventsService } = await import("../services/workspaceevents");

/** Build a page of `n` fake subscriptions. */
function page(n: number, from: number, nextPageToken?: string) {
  return {
    subscriptions: Array.from({ length: n }, (_, i) => ({ name: `subscriptions/s${from + i}` })),
    nextPageToken,
  };
}

describe("WorkspaceEventsService.listSubscriptions", () => {
  beforeEach(() => googleJson.mockReset());

  it("pages past the 100-per-page boundary instead of stopping at it", async () => {
    googleJson
      .mockResolvedValueOnce(page(100, 0, "tok-1"))
      .mockResolvedValueOnce(page(100, 100, "tok-2"))
      .mockResolvedValueOnce(page(53, 200));

    const svc = new WorkspaceEventsService({} as Env, "ref");
    const { subscriptions, truncated } = await svc.listSubscriptions('event_types:"x"');

    expect(subscriptions).toHaveLength(253);
    expect(truncated).toBe(false);
    expect(googleJson).toHaveBeenCalledTimes(3);
    // The cursor must actually be sent, or page 2 repeats page 1 forever.
    expect(String(googleJson.mock.calls[1][2])).toContain("pageToken=tok-1");
  });

  it("reports truncation rather than passing off a capped list as complete", async () => {
    googleJson.mockResolvedValue(page(100, 0, "always-more"));
    const svc = new WorkspaceEventsService({} as Env, "ref");
    const { subscriptions, truncated } = await svc.listSubscriptions('event_types:"x"', 3);
    expect(truncated).toBe(true);
    expect(subscriptions.length).toBeGreaterThan(100);
  });

  it("returns a single page without asking for another", async () => {
    googleJson.mockResolvedValueOnce(page(1, 0));
    const svc = new WorkspaceEventsService({} as Env, "ref");
    const { subscriptions, truncated } = await svc.listSubscriptions('target_resource="x"');
    expect(subscriptions).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(googleJson).toHaveBeenCalledTimes(1);
  });
});
