/**
 * @fileoverview The known body the Gmail harness composes on the live worker.
 *
 * Markdown, because that is what agents send. It exercises every rule the
 * standard checks: several paragraphs, bold, a link, a real bulleted list, a
 * real numbered list, a line break inside a paragraph, and an inline image
 * bound by `cid:`. {@link FIXTURE_EXPECT} states what it must render to.
 *
 * @example
 * ```typescript
 * import { FIXTURE_MARKDOWN, FIXTURE_EXPECT } from "@/backend/gmail/harness/fixture";
 * ```
 */
import type { StandardExpectations } from "@/backend/gmail/harness/checks";

/** Content-ID of the inline pixel the fixture body references. */
export const FIXTURE_CID = "gmail-harness-pixel";

/** A 1×1 transparent PNG, base64. */
export const FIXTURE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The known body. Do not "tidy" it: every line exercises a rule. */
export const FIXTURE_MARKDOWN = [
  "Hello harness,",
  "",
  "This paragraph checks **bold** text and a [link](https://example.com/gmail-harness).",
  "",
  "Bullets:",
  "",
  "- alpha",
  "- bravo",
  "- charlie",
  "",
  "Steps:",
  "",
  "1. first",
  "2. second",
  "3. third",
  "",
  `![pixel](cid:${FIXTURE_CID})`,
  "",
  "Thanks,",
  "Harness",
].join("\n");

/** What {@link FIXTURE_MARKDOWN} must render to under the standard. */
export const FIXTURE_EXPECT: StandardExpectations = {
  bullets: ["alpha", "bravo", "charlie"],
  steps: ["first", "second", "third"],
  minParagraphs: 5,
  inlineContentId: FIXTURE_CID,
};

/** Text the round-trip appends, then looks for in the updated draft. */
export const FIXTURE_APPEND_MARKDOWN = "P.S. gmail-harness round-trip edit.";

/** A cc the round-trip adds. Drafts are never sent and are deleted at the end. */
export const FIXTURE_CC = "gmail-harness-cc@example.com";
