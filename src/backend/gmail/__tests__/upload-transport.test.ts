import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../mcp/tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import {
  mimeByteLength,
  assertMessageFitsGmail,
  sendRawMessage,
  createRawDraft,
  GmailBodyTooLargeError,
  GmailMessageTooLargeError,
  GMAIL_UPLOAD_MAX_BYTES,
  GMAIL_UPLOAD_THRESHOLD_BYTES,
  GMAIL_BODY_HEADROOM_BYTES,
} from "../upload-transport";

/** A valid base64url string of exactly `chars` length ("A" decodes cleanly). */
function rawOfLength(chars: number): string {
  return "A".repeat(chars);
}

/** Smallest base64url length whose decoded MIME size exceeds `bytes`. */
function rawLengthForBytes(bytes: number): number {
  return Math.floor((bytes * 4) / 3) + 4;
}

/** Decode a multipart media part back to the MIME text for assertions. */
function decodeBody(body: BodyInit | null | undefined): string {
  return new TextDecoder().decode(body as Uint8Array);
}

const env = {} as unknown as Env;

// Built once (each is a multi-MB string): a message just over the 35 MiB
// ceiling, and one just over the 5 MiB JSON-vs-upload threshold.
const OVERSIZED_RAW = rawOfLength(rawLengthForBytes(GMAIL_UPLOAD_MAX_BYTES));
const LARGE_RAW = rawOfLength(rawLengthForBytes(GMAIL_UPLOAD_THRESHOLD_BYTES));

describe("upload-transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("mimeByteLength", () => {
    it("decodes exact byte length for each base64 remainder", () => {
      // "AAAA" -> 3 bytes; "AAAAAA" (len 6, rem 2) -> 4; "AAAAAAA" (len 7, rem 3) -> 5.
      expect(mimeByteLength("AAAA")).toBe(3);
      expect(mimeByteLength("AAAAAA")).toBe(4);
      expect(mimeByteLength("AAAAAAA")).toBe(5);
    });

    it("matches the actual decoded size of a real raw MIME", () => {
      const mime = "To: a@b.com\r\nSubject: Hi\r\n\r\nBody with ünïcode.";
      const bytes = new TextEncoder().encode(mime);
      const raw = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(mimeByteLength(raw)).toBe(bytes.length);
    });
  });

  describe("assertMessageFitsGmail", () => {
    it("returns the measured size when within limits", () => {
      const raw = rawOfLength(4000); // ~3000 bytes
      expect(assertMessageFitsGmail(raw, 1000)).toBe(3000);
    });

    it("throws GmailBodyTooLargeError when the body alone is over the ceiling minus headroom", () => {
      const overBody = GMAIL_UPLOAD_MAX_BYTES - GMAIL_BODY_HEADROOM_BYTES + 1;
      expect(() => assertMessageFitsGmail("AAAA", overBody)).toThrow(GmailBodyTooLargeError);
    });

    it("throws GmailMessageTooLargeError when the whole message is over the ceiling", () => {
      expect(mimeByteLength(OVERSIZED_RAW)).toBeGreaterThan(GMAIL_UPLOAD_MAX_BYTES);
      expect(() => assertMessageFitsGmail(OVERSIZED_RAW, 1000)).toThrow(GmailMessageTooLargeError);
    });

    it("prefers the body error when both the body and the message are oversized", () => {
      const overBody = GMAIL_UPLOAD_MAX_BYTES; // also over the body limit
      expect(() => assertMessageFitsGmail(OVERSIZED_RAW, overBody)).toThrow(GmailBodyTooLargeError);
    });
  });

  describe("sendRawMessage", () => {
    it("posts JSON { raw } to the non-upload endpoint for a small message", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "sent1", threadId: "t1" }), { status: 200 }),
        );
      const out = await sendRawMessage(env, "s", {
        raw: rawOfLength(400),
        bodyRawBytes: 100,
        threadId: "t1",
      });
      expect(out.id).toBe("sent1");
      const [url, init] = spy.mock.calls[0];
      expect(String(url)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      expect((init as RequestInit).method).toBe("POST");
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload).toEqual({ raw: rawOfLength(400), threadId: "t1" });
    });

    it("uploads the raw MIME as a message/rfc822 part above the threshold", async () => {
      expect(mimeByteLength(LARGE_RAW)).toBeGreaterThan(GMAIL_UPLOAD_THRESHOLD_BYTES);
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ id: "big1" }), { status: 200 }));
      const out = await sendRawMessage(env, "s", {
        raw: LARGE_RAW,
        bodyRawBytes: 100,
        threadId: "thread9",
      });
      expect(out.id).toBe("big1");
      const [url, init] = spy.mock.calls[0];
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
      );
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["content-type"]).toMatch(/^multipart\/related; boundary=/);
      const text = decodeBody((init as RequestInit).body);
      expect(text).toContain("Content-Type: application/json; charset=UTF-8");
      expect(text).toContain('"threadId":"thread9"');
      expect(text).toContain("Content-Type: message/rfc822");
      // The decoded MIME (all-zero bytes from "A...") must be present verbatim.
      expect((init as RequestInit).body).toBeInstanceOf(Uint8Array);
    });

    it("throws before any network call when the body is oversized", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      await expect(
        sendRawMessage(env, "s", { raw: rawOfLength(400), bodyRawBytes: GMAIL_UPLOAD_MAX_BYTES }),
      ).rejects.toBeInstanceOf(GmailBodyTooLargeError);
      expect(spy).not.toHaveBeenCalled();
    });

    it("throws before any network call when the whole message is oversized", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      await expect(
        sendRawMessage(env, "s", { raw: OVERSIZED_RAW, bodyRawBytes: 100 }),
      ).rejects.toBeInstanceOf(GmailMessageTooLargeError);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("createRawDraft", () => {
    it("posts JSON { message: { raw } } to the non-upload drafts endpoint for a small draft", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "d1", message: { id: "m1" } }), { status: 200 }),
        );
      const out = await createRawDraft(env, "s", { raw: rawOfLength(400), bodyRawBytes: 100 });
      expect(out.id).toBe("d1");
      const [url, init] = spy.mock.calls[0];
      expect(String(url)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        message: { raw: rawOfLength(400) },
      });
    });

    it("uploads a large draft via the multipart endpoint, threadId in the metadata part", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "d2", message: { id: "m2", threadId: "t2" } }), {
            status: 200,
          }),
        );
      const out = await createRawDraft(env, "s", {
        raw: LARGE_RAW,
        bodyRawBytes: 100,
        threadId: "t2",
      });
      expect(out.id).toBe("d2");
      const [url, init] = spy.mock.calls[0];
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart",
      );
      const text = decodeBody((init as RequestInit).body);
      expect(text).toContain('"message":{"threadId":"t2"}');
      expect(text).toContain("Content-Type: message/rfc822");
    });
  });
});
