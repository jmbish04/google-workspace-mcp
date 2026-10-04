/**
 * Pure parts of the draft studio: how a revision body is rendered, and the
 * guard that decides whether a draft may leave the studio. The D1 and Gmail
 * paths are covered by the route/service integration surface, not here.

 */
import { describe, it, expect } from "vitest";

import { assertSendable, renderStudioBody, type DraftWithHistory } from "../draft-studio";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function draft(over: Partial<DraftWithHistory> = {}): DraftWithHistory {
  const current = {
    id: "r1", draftId: "d1", n: 1, html: "<div>hi</div>", text: "hi",
    source: "agent" as const, note: null, createdAt: new Date(),
  };
  return {
    id: "d1", account: "a", toAddr: "x@y.com", ccAddr: null, bccAddr: null, subject: "Hi",
    replyToMessageId: null, threadId: null, status: "drafting", currentRevision: 1, uuid: UUID,
    gmailDraftId: null, sentMessageId: null, createdBySub: null,
    createdAt: new Date(), updatedAt: new Date(),
    revisions: [current], comments: [], current,
    ...over,
  } as DraftWithHistory;
}

describe("renderStudioBody", () => {
  it("renders a Tiptap edit into the exact Gmail HTML that would be sent", () => {
    const out = renderStudioBody(
      {
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Hello " },
                { type: "text", text: "Bob", marks: [{ type: "bold" }] },
              ],
            },
          ],
        },
      },
      UUID,
    );
    expect(out.html).toContain('<div dir="ltr"');
    expect(out.html).toMatch(/<strong[^>]*>Bob<\/strong>/);
    expect(out.html).toContain(`ref:${UUID}`);
    expect(out.text).toBe("Hello Bob");
  });

  it("prefers the Tiptap doc over a stale html field", () => {
    const out = renderStudioBody(
      { doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] }, html: "<p>old</p>" },
      UUID,
    );
    expect(out.text).toBe("new");
  });

  it("keeps the draft's reference id across revisions instead of minting a new one", () => {
    const a = renderStudioBody({ markdown: "v1" }, UUID);
    const b = renderStudioBody({ markdown: "v2" }, UUID);
    expect(a.html).toContain(`ref:${UUID}`);
    expect(b.html).toContain(`ref:${UUID}`);
    expect(b.html.split("ref:").length - 1).toBe(1);
  });
});

describe("assertSendable", () => {
  it("accepts a complete draft", () => {
    expect(() => assertSendable(draft())).not.toThrow();
  });

  it("refuses to send twice", () => {
    expect(() => assertSendable(draft({ status: "sent" }))).toThrow(/already been sent/);
  });

  it("refuses an empty draft", () => {
    expect(() => assertSendable(draft({ current: null, revisions: [] }))).toThrow(/no body/);
  });

  it("refuses a draft with no recipients or no subject", () => {
    expect(() => assertSendable(draft({ toAddr: null }))).toThrow(/no recipients/);
    expect(() => assertSendable(draft({ subject: null }))).toThrow(/no subject/);
  });

  it("allows a reply with neither, because the thread supplies both", () => {
    expect(() => assertSendable(draft({ toAddr: null, subject: null, replyToMessageId: "m1" }))).not.toThrow();
  });
});
