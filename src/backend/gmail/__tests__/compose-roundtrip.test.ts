/**
 * @fileoverview Re-composing a body that already went through `composeBody`
 * with the SAME reference id — the path a draft edit takes (Draft Studio
 * revisions today, `gmail_update_draft` next).
 *
 * The defect these pin (measured 2026-10-23): the body's own hidden
 * `ref:<uuid>` `<div>` survived `stripForeignStamps` (it is "ours"), then
 * `toEmailBlocks` retagged it as an ordinary `<p>`, dropping its hidden style.
 * The recipient read `ref:1111…` as a line of body text.
 */
import { describe, expect, it } from "vitest";

import { composeBody, refMarkerHtml } from "@/backend/gmail/compose";

const UUID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const MD = "Hello Sam,\n\nThe plan:\n\n- one\n- two\n\nThanks,\nJustin";

/** Every element whose own text is a `ref:<uuid>` marker. */
function markers(html: string): string[] {
  return html.match(/<(\w+)[^>]*>\s*ref:[0-9a-f-]{36}\s*<\/\1>/gi) ?? [];
}

describe("composeBody — re-composing with the same reference id", () => {
  it("keeps exactly one marker, and it stays hidden", () => {
    const first = composeBody({ markdown: MD }, { uuid: UUID });
    const second = composeBody({ html: first.html }, { uuid: UUID });

    const found = markers(second.html);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("color:#ffffff");
    expect(found[0]).toContain("data-plaintext=\"omit\"");
    // Never retagged into a visible paragraph.
    expect(second.html).not.toMatch(/<p[^>]*>\s*ref:/i);
    expect(second.text).not.toContain("ref:");
  });

  it("is idempotent: composing the composed body again changes nothing", () => {
    const first = composeBody({ markdown: MD }, { uuid: UUID });
    const second = composeBody({ html: first.html }, { uuid: UUID });
    const third = composeBody({ html: second.html }, { uuid: UUID });
    expect(second.html).toBe(first.html);
    expect(third.html).toBe(first.html);
  });

  it("an appended edit still ships one hidden marker, after the new text", () => {
    const first = composeBody({ markdown: MD }, { uuid: UUID });
    const inner = first.html.replace(/^<div dir="ltr"[^>]*>/, "").replace(/<\/div>$/, "");
    const edited = composeBody({ html: `${inner}<p>P.S. one more thing.</p>` }, { uuid: UUID });

    expect(markers(edited.html)).toHaveLength(1);
    expect(edited.html.indexOf("P.S.")).toBeLessThan(edited.html.indexOf(`ref:${UUID}`));
    expect(edited.html).not.toMatch(/<p[^>]*>\s*ref:/i);
  });

  it("still strips a FOREIGN marker and keeps only its own", () => {
    const body = `<p>Hi</p>${refMarkerHtml(OTHER)}${refMarkerHtml(UUID)}`;
    const r = composeBody({ html: body }, { uuid: UUID });
    expect(markers(r.html)).toHaveLength(1);
    expect(r.html).toContain(`ref:${UUID}`);
    expect(r.html).not.toContain(OTHER);
    expect(r.report.removedRefs).toEqual([OTHER]);
  });
});
