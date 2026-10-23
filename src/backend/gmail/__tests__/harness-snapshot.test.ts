/**
 * @fileoverview `snapshotFromGmail` — the parser between Gmail's stored draft
 * and the harness checks. If it misreads the message, every live check reads
 * the wrong thing, so it is pinned on its own.
 */
import { describe, expect, it } from "vitest";

import { snapshotFromGmail } from "@/backend/gmail/harness/snapshot";

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const draft = {
  id: "r-1",
  message: {
    id: "m-1",
    threadId: "t-9",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: '"Justin Bishop" <justin@example.com>' },
        { name: "Cc", value: "a@example.com" },
        { name: "Subject", value: "Hi" },
      ],
      parts: [
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: b64url("Hello — plain") } },
                { mimeType: "text/html", body: { data: b64url("<p>Hello — html</p>") } },
              ],
            },
            {
              mimeType: "image/png",
              filename: "pixel.png",
              headers: [
                { name: "Content-ID", value: "<gmail-harness-pixel>" },
                { name: "Content-Disposition", value: 'inline; filename="pixel.png"' },
              ],
              body: { attachmentId: "att-1", size: 70 },
            },
          ],
        },
        {
          // A text/plain FILE must not be mistaken for the body.
          mimeType: "text/plain",
          filename: "gmail-harness.txt",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="gmail-harness.txt"' }],
          body: { data: b64url("NOT THE BODY") },
        },
      ],
    },
  },
};

describe("snapshotFromGmail", () => {
  it("reads the body parts, headers, thread and every MIME leaf", () => {
    const s = snapshotFromGmail(draft);
    expect(s.html).toBe("<p>Hello — html</p>");
    expect(s.text).toBe("Hello — plain");
    expect(s.headers.from).toBe('"Justin Bishop" <justin@example.com>');
    expect(s.headers.cc).toBe("a@example.com");
    expect(s.threadId).toBe("t-9");
    expect(s.parts).toEqual([
      { mimeType: "text/plain" },
      { mimeType: "text/html" },
      { mimeType: "image/png", filename: "pixel.png", contentId: "gmail-harness-pixel", disposition: "inline" },
      { mimeType: "text/plain", filename: "gmail-harness.txt", disposition: "attachment" },
    ]);
  });

  it("never reads an attached text file as the text/plain body", () => {
    const onlyFile = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [draft.message.payload.parts[1]],
      },
    };
    expect(snapshotFromGmail(onlyFile).text).toBe("");
  });
});
