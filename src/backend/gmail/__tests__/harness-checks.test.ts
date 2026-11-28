/**
 * @fileoverview The harness's standard checks and verdict rule.
 *
 * The baseline is REAL `composeBody` output for the fixture, so a regression in
 * compose.ts turns these red too. Every planted regression must flip exactly
 * the check it targets and change the verdict — a check that cannot fail is
 * not a check.
 */
import { describe, expect, it } from "vitest";

import { composeBody } from "@/backend/gmail/compose";
import { aggregateVerdict, checkStandard, type DraftSnapshot, type HarnessCheck } from "@/backend/gmail/harness/checks";
import { FIXTURE_CID, FIXTURE_EXPECT, FIXTURE_MARKDOWN } from "@/backend/gmail/harness/fixture";
import { PLANTS, PLANT_TARGETS, plantRegression } from "@/backend/gmail/harness/plant";

const UUID = "abcdefab-1234-4567-89ab-abcdefabcdef";

function baseline(): DraftSnapshot {
  const { html, text } = composeBody({ markdown: FIXTURE_MARKDOWN }, { uuid: UUID });
  return {
    html,
    text,
    headers: { from: '"Justin Bishop" <justin@example.com>', subject: "[gmail-harness] t" },
    parts: [
      { mimeType: "text/plain" },
      { mimeType: "text/html" },
      { mimeType: "image/png", filename: "pixel.png", contentId: FIXTURE_CID, disposition: "inline" },
    ],
    threadId: "t1",
  };
}

const run = (s: DraftSnapshot) => checkStandard(s, { uuid: UUID, expect: FIXTURE_EXPECT });
const failed = (cs: HarnessCheck[]) => cs.filter((c) => c.status === "fail").map((c) => c.name);

describe("checkStandard on real composeBody output", () => {
  it("passes every check for the fixture body", () => {
    const checks = run(baseline());
    expect(failed(checks)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      "container_650",
      "typography_arial_14_1_5_222222",
      "paragraph_spacing_16px",
      "real_lists",
      "single_ref_marker",
      "links_1155cc",
      "styles_inlined",
      "text_plain_alternative",
      "sender_display_name",
      "inline_cid_binding",
    ]);
    expect(aggregateVerdict(checks)).toBe("pass");
  });

  it("fails single_ref_marker when the reported uuid is not the one stamped", () => {
    const checks = checkStandard(baseline(), { uuid: "00000000-0000-4000-8000-000000000001", expect: FIXTURE_EXPECT });
    expect(failed(checks)).toEqual(["single_ref_marker"]);
  });
});

describe("every planted regression turns its check red and changes the verdict", () => {
  for (const plant of PLANTS) {
    it(`${plant} → ${PLANT_TARGETS[plant]}`, () => {
      const before = baseline();
      const broken = plantRegression(before, plant);
      expect(broken.html + JSON.stringify(broken.headers) + broken.text + broken.parts.length).not.toBe(
        before.html + JSON.stringify(before.headers) + before.text + before.parts.length,
      );
      const checks = run(broken);
      expect(failed(checks)).toContain(PLANT_TARGETS[plant]);
      const target = checks.find((c) => c.name === PLANT_TARGETS[plant])!;
      expect(aggregateVerdict(checks)).toBe(target.severity === "minor" ? "degraded" : "fail");
      // The original is never mutated.
      expect(failed(run(before))).toEqual([]);
    });
  }
});

describe("aggregateVerdict", () => {
  const c = (severity: HarnessCheck["severity"], status: HarnessCheck["status"]): HarnessCheck => ({
    name: `${severity}-${status}`,
    severity,
    status,
    message: "",
  });

  it("a failed critical or major check fails the run, even alongside skips", () => {
    expect(aggregateVerdict([c("critical", "fail"), c("major", "pass")])).toBe("fail");
    expect(aggregateVerdict([c("major", "fail"), c("major", "skipped")])).toBe("fail");
  });
  it("a skipped check is never a pass", () => {
    expect(aggregateVerdict([c("critical", "pass"), c("major", "skipped")])).toBe("incomplete");
    expect(aggregateVerdict([c("minor", "fail"), c("major", "skipped")])).toBe("incomplete");
  });
  it("a failed minor check degrades", () => {
    expect(aggregateVerdict([c("critical", "pass"), c("minor", "fail")])).toBe("degraded");
  });
  it("no checks at all is not a pass", () => {
    expect(aggregateVerdict([])).toBe("incomplete");
  });
});
