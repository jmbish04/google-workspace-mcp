import { describe, it, expect } from "vitest";

import { parseCron, isValidCron, cronMatches, cronDueSince } from "../cron";

const at = (iso: string) => new Date(iso);

describe("parseCron / isValidCron", () => {
  it("accepts valid 5-field expressions", () => {
    expect(isValidCron("0 14 * * 1")).toBe(true);
    expect(isValidCron("*/15 0-6 1,15 * *")).toBe(true);
  });
  it("rejects malformed expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("0 14 * *")).toBe(false); // 4 fields
    expect(isValidCron("60 * * * *")).toBe(false); // minute out of range
    expect(isValidCron("* * * * 8")).toBe(false); // dow out of range
    expect(isValidCron("*/0 * * * *")).toBe(false); // bad step
  });
});

describe("cronMatches", () => {
  it("matches a specific weekday time (UTC)", () => {
    const c = parseCron("0 14 * * 1")!; // Mondays 14:00 UTC
    expect(cronMatches(c, at("2026-08-10T14:00:00Z"))).toBe(true); // Mon
    expect(cronMatches(c, at("2026-08-10T14:01:00Z"))).toBe(false); // wrong minute
    expect(cronMatches(c, at("2026-08-11T14:00:00Z"))).toBe(false); // Tue
  });

  it("supports step ranges", () => {
    const c = parseCron("*/15 * * * *")!;
    expect(cronMatches(c, at("2026-08-10T10:30:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-08-10T10:31:00Z"))).toBe(false);
  });

  it("Vixie OR semantics when both dom and dow are restricted", () => {
    const c = parseCron("0 0 13 * 5")!; // 13th OR any Friday, 00:00
    expect(cronMatches(c, at("2026-08-13T00:00:00Z"))).toBe(true); // 13th (Thu)
    expect(cronMatches(c, at("2026-08-14T00:00:00Z"))).toBe(true); // Friday
    expect(cronMatches(c, at("2026-08-12T00:00:00Z"))).toBe(false); // Wed, not 13th
  });

  it("treats 0 and 7 as Sunday", () => {
    const c = parseCron("0 0 * * 7")!;
    expect(cronMatches(c, at("2026-08-09T00:00:00Z"))).toBe(true); // Sunday
  });
});

describe("cronDueSince", () => {
  it("is due when an occurrence falls inside the window", () => {
    const now = at("2026-08-10T15:00:00Z").getTime();
    const since = at("2026-08-10T13:30:00Z").getTime(); // 14:00 Mon occurrence is inside
    expect(cronDueSince("0 14 * * 1", since, now)).toBe(true);
  });

  it("is not due when no occurrence is inside the window", () => {
    const now = at("2026-08-10T13:20:00Z").getTime();
    const since = at("2026-08-10T13:00:00Z").getTime();
    expect(cronDueSince("0 14 * * 1", since, now)).toBe(false);
  });

  it("excludes the `since` minute itself, includes `now`", () => {
    const t = at("2026-08-10T14:00:00Z").getTime();
    expect(cronDueSince("0 14 * * 1", t, t)).toBe(false); // window is empty
    expect(cronDueSince("0 14 * * 1", t - 60_000, t)).toBe(true); // now included
  });
});
