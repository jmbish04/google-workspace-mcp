import { describe, expect, it } from "vitest";

import { stampReferenceId } from "../build-outgoing";
import { buildRawMessage } from "../mime";

describe("stampReferenceId", () => {
  it("appends a trailing ref line to text and a hidden line to html", () => {
    const out = stampReferenceId({ text: "Hello there", html: "<html><body><p>Hello there</p></body></html>" }, "CD-7K3M2Q");
    expect(out.text).toBe("Hello there\n\nref: CD-7K3M2Q\n");
    expect(out.html).toContain("ref: CD-7K3M2Q");
    expect(out.html).toMatch(/display:none[^>]*>ref: CD-7K3M2Q<\/div><\/body>/);
  });
  it("is idempotent", () => {
    const once = stampReferenceId({ text: "Hi" }, "abc");
    expect(stampReferenceId(once, "abc")).toEqual(once);
  });
  it("puts the hidden line at the end when there is no </body>", () => {
    expect(stampReferenceId({ text: "x", html: "<p>x</p>" }, "id1").html).toMatch(/<p>x<\/p><div[^>]*>ref: id1<\/div>$/);
  });
});

describe("buildRawMessage extraHeaders", () => {
  const decode = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  it("emits X-Colby-Ref and drops unsafe headers", () => {
    const raw = buildRawMessage({ to: "a@b.c", subject: "s", text: "t", extraHeaders: { "X-Colby-Ref": "CD-7K3M2Q", "Bad Header": "x", "X-Ok": "line\nbreak" } });
    const mime = decode(raw);
    expect(mime).toContain("X-Colby-Ref: CD-7K3M2Q");
    expect(mime).not.toContain("Bad Header");
    expect(mime).not.toContain("X-Ok");
  });
});
