import { describe, it, expect, vi, afterEach } from "vitest";
import { GmailService } from "../gmail";
import { composeBody } from "@/backend/gmail/compose";
vi.mock("../../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

describe("GmailService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listMessages queries users/me/messages", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }), { status: 200 }));
    const out = await new GmailService({} as any, "s1").listMessages("from:x");
    expect(out.messages[0].id).toBe("m1");
    expect(decodeURIComponent(spy.mock.calls[0][0] as string)).toContain("q=from:x");
  });
  /** Find the call that actually posted the message/draft (identity lookups come first). */
  function postedTo(spy: ReturnType<typeof vi.spyOn>, path: string) {
    const call = spy.mock.calls.find((c: any[]) => String(c[0]).includes(path) && (c[1] as RequestInit)?.method === "POST")!;
    return { url: String(call[0]), init: call[1] as RequestInit, body: JSON.parse((call[1] as RequestInit).body as string) };
  }

  function decodeMime(raw: string) {
    return decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))));
  }

  /** Gmail identity endpoints, so From resolution has something to read. */
  function mockIdentity(spy: ReturnType<typeof vi.spyOn>, rest: (url: string) => Response) {
    spy.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/profile")) return new Response(JSON.stringify({ emailAddress: "me@self.com" }), { status: 200 });
      if (u.includes("/settings/sendAs")) {
        return new Response(
          JSON.stringify({ sendAs: [{ sendAsEmail: "me@self.com", displayName: "Justin Bishop", isPrimary: true }] }),
          { status: 200 },
        );
      }
      return rest(u);
    });
  }

  it("send posts base64url raw to messages/send", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "sent1" }), { status: 200 }));
    const out = await new GmailService({} as any, "send-1").send("a@b.com", "Hi", "Body");
    expect(out.id).toBe("sent1");
    expect(typeof postedTo(spy, "/messages/send").body.raw).toBe("string");
  });

  it("puts the sender's display name on the From header", async () => {
    // Without this the recipient's inbox shows a bare address instead of a name.
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "sent1" }), { status: 200 }));
    await new GmailService({} as any, "send-named").send("a@b.com", "Hi", "Body");
    expect(decodeMime(postedTo(spy, "/messages/send").body.raw)).toContain('From: "Justin Bishop" <me@self.com>');
  });

  it("sends an HTML alternative even for a plain-text body", async () => {
    // A text-only part loses bullets, numbering, links and paragraph spacing.
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "sent1" }), { status: 200 }));
    await new GmailService({} as any, "send-html").send("a@b.com", "Hi", "One.\n\nTwo.");
    const mime = decodeMime(postedTo(spy, "/messages/send").body.raw);
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/html");
    expect(mime).toContain('<div dir="ltr"');
  });

  it("applies a changed sender name to the very next message", async () => {
    // Measured in production 2026-10-03: the first version cached the whole
    // resolved From header for 10 minutes, so set_sender_name reported success
    // and outgoing mail kept the old bare address — and the cache being
    // per-isolate meant the write could not invalidate it. The override must
    // therefore be read fresh on every send.
    const names: (string | undefined)[] = ["Old Name", "New Name"];
    const svc = new GmailService({} as any, "rename-live");
    // Stand in for the global_config read the resolver does.
    (svc as any).configuredSenderName = async () => names.shift();

    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "draft1" }), { status: 200 }));

    await svc.createDraft("a@b.com", "One", "Body");
    expect(decodeMime(postedTo(spy, "/drafts").body.message.raw)).toContain('From: "Old Name" <me@self.com>');

    spy.mockClear();
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "draft2" }), { status: 200 }));
    await svc.createDraft("a@b.com", "Two", "Body");
    expect(decodeMime(postedTo(spy, "/drafts").body.message.raw)).toContain('From: "New Name" <me@self.com>');
  });

  it("createDraft posts message.raw to drafts", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "draft1" }), { status: 200 }));
    const out = await new GmailService({} as any, "draft-1").createDraft("a@b.com", "Hi", "Body");
    expect(out.id).toBe("draft1");
    const posted = postedTo(spy, "/drafts");
    expect(typeof posted.body.message.raw).toBe("string");
  });

  it("createDraft threads Cc and Bcc into the raw MIME headers", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "draft1" }), { status: 200 }));
    await new GmailService({} as any, "draft-cc").createDraft("a@b.com", "Hi", "Body", { cc: "c@x.com", bcc: "d@y.com" });
    const mime = decodeMime(postedTo(spy, "/drafts").body.message.raw);
    expect(mime).toContain("Cc: c@x.com");
    expect(mime).toContain("Bcc: d@y.com");
  });

  it("createDraft supports multiple To recipients (comma-separated)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "draft1" }), { status: 200 }));
    await new GmailService({} as any, "draft-multi").createDraft("a@b.com, c@d.com", "Hi", "Body", { cc: "e@f.com" });
    const mime = decodeMime(postedTo(spy, "/drafts").body.message.raw);
    expect(mime).toContain("To: a@b.com, c@d.com");
    expect(mime).toContain("Cc: e@f.com");
  });

  function mockHeadersAndProfile(spy: ReturnType<typeof vi.spyOn>) {
    spy.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/profile")) {
        return new Response(JSON.stringify({ emailAddress: "me@self.com" }), { status: 200 });
      }
      if (u.includes("/settings/sendAs")) {
        return new Response(
          JSON.stringify({ sendAs: [{ sendAsEmail: "me@self.com", displayName: "Justin Bishop", isPrimary: true }] }),
          { status: 200 },
        );
      }
      if (u.includes("/messages/")) {
        return new Response(
          JSON.stringify({
            threadId: "thread1",
            payload: {
              headers: [
                { name: "From", value: "Alice <alice@x.com>" },
                { name: "To", value: "me@self.com, Bob <bob@y.com>" },
                { name: "Cc", value: "carol@z.com" },
                { name: "Subject", value: "Hello" },
                { name: "Message-ID", value: "<orig-id@mail.gmail.com>" },
                { name: "References", value: "<prev@mail.gmail.com>" },
              ],
            },
          }),
          { status: 200 },
        );
      }
      // drafts POST
      return new Response(JSON.stringify({ id: "draft2", message: { id: "m2", threadId: "thread1" } }), { status: 200 });
    });
  }

  it("createReplyDraft defaults to reply-all in the same thread", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockHeadersAndProfile(spy);
    const out = await new GmailService({} as any, "reply-all").createReplyDraft("msg1", "Thanks!");
    expect(out.id).toBe("draft2");

    const draftCall = spy.mock.calls.find((c: any[]) => String(c[0]).includes("/drafts"))!;
    const draftInit = draftCall[1] as RequestInit;
    expect(draftInit.method).toBe("POST");
    const draftBody = JSON.parse(draftInit.body as string);
    expect(draftBody.message.threadId).toBe("thread1");

    const raw = draftBody.message.raw as string;
    const mime = decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(mime).toContain("In-Reply-To: <orig-id@mail.gmail.com>");
    expect(mime).toContain("References: <prev@mail.gmail.com> <orig-id@mail.gmail.com>");
    expect(mime).toContain("Subject: Re: Hello");
    expect(mime).toContain("alice@x.com");
    expect(mime).toContain("bob@y.com");
    expect(mime).toContain("carol@z.com");
    // Reply-all must not mail the account back to itself — check the recipient
    // headers specifically, since From legitimately carries the same address.
    expect(mime).not.toMatch(/^(To|Cc|Bcc):.*me@self\.com/m);
    expect(mime).toContain('From: "Justin Bishop" <me@self.com>');
  });

  it("createReplyDraft honors opts.to override", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockHeadersAndProfile(spy);
    await new GmailService({} as any, "reply-to").createReplyDraft("msg1", "Thanks!", { to: ["x@y.com"] });

    const draftCall = spy.mock.calls.find((c: any[]) => String(c[0]).includes("/drafts"))!;
    const draftInit = draftCall[1] as RequestInit;
    const draftBody = JSON.parse(draftInit.body as string);
    const raw = draftBody.message.raw as string;
    const mime = decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))));
    expect(mime).toContain("To: x@y.com");
    expect(mime).not.toContain("alice@x.com");
  });

  /** Find the POST whose URL contains `/upload/gmail/v1` (the media-upload path). */
  function uploadPost(spy: ReturnType<typeof vi.spyOn>) {
    const call = spy.mock.calls.find(
      (c: any[]) => String(c[0]).includes("/upload/gmail/v1") && (c[1] as RequestInit)?.method === "POST",
    );
    return call ? { url: String(call[0]), init: call[1] as RequestInit } : undefined;
  }

  /** A large inline blob whose composed MIME clears the 5 MiB JSON→upload threshold. */
  function bigBlob() {
    return { filename: "big.bin", contentBase64: btoa("a".repeat(6 * 1024 * 1024)) };
  }

  it("send routes a large message through the /upload/gmail/v1 multipart endpoint", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "big-send" }), { status: 200 }));
    const out = await new GmailService({} as any, "send-big").send("a@b.com", "Hi", "Body", { blobs: [bigBlob()] });
    expect(out.id).toBe("big-send");
    const posted = uploadPost(spy);
    expect(posted).toBeDefined();
    expect(posted!.url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
    expect(String((posted!.init.headers as Record<string, string>)["content-type"])).toMatch(/^multipart\/related;/);
    expect(posted!.init.body).toBeInstanceOf(Uint8Array);
    // The small-message JSON endpoint must NOT have been used for this send.
    const jsonSend = spy.mock.calls.find((c: any[]) => String(c[0]) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(jsonSend).toBeUndefined();
  });

  it("createDraft routes a large draft through the /upload/gmail/v1 multipart endpoint", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockIdentity(spy, () => new Response(JSON.stringify({ id: "big-draft", message: { id: "m" } }), { status: 200 }));
    const out = await new GmailService({} as any, "draft-big").createDraft("a@b.com", "Hi", "Body", { blobs: [bigBlob()] });
    expect(out.id).toBe("big-draft");
    const posted = uploadPost(spy);
    expect(posted).toBeDefined();
    expect(posted!.url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart");
    const text = new TextDecoder().decode(posted!.init.body as Uint8Array);
    expect(text).toContain("Content-Type: message/rfc822");
  });

  it("listLabels fetches users/me/labels", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ labels: [{ id: "l1", name: "Work" }] }), { status: 200 }));
    const out = await new GmailService({} as any, "s1").listLabels();
    expect(out.labels).toEqual([{ id: "l1", name: "Work" }]);
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
  });

  it("createLabel posts name with visibility defaults", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "l2", name: "Urgent" }), { status: 200 }));
    const out = await new GmailService({} as any, "s1").createLabel("Urgent");
    expect(out.id).toBe("l2");
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ name: "Urgent", labelListVisibility: "labelShow", messageListVisibility: "show" });
  });

  it("modifyMessageLabels posts add/remove label ids", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    await new GmailService({} as any, "s1").modifyMessageLabels("m1", ["LABEL_A"], ["LABEL_B"]);
    const url = spy.mock.calls[0][0] as string;
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify");
    expect(JSON.parse(init.body as string)).toEqual({ addLabelIds: ["LABEL_A"], removeLabelIds: ["LABEL_B"] });
  });

  it("getThread fetches thread with format=full", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "t1", messages: [] }), { status: 200 }));
    const out = await new GmailService({} as any, "s1").getThread("t1");
    expect(out.id).toBe("t1");
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/threads/t1?format=full");
  });

  it("trashMessage posts to messages/{id}/trash", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    await new GmailService({} as any, "s1").trashMessage("m1");
    const url = spy.mock.calls[0][0] as string;
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/trash");
    expect(init.method).toBe("POST");
  });

  // ---- getDraft / updateDraft (the CC bug: edit an existing draft) --------

  const DRAFT_UUID = "11111111-2222-4333-8444-555555555555";
  const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  /** A draft as Gmail returns it `format=full`: threaded, one Cc, one pdf, one hidden ref marker. */
  function draftMessage() {
    const built = composeBody({ markdown: "Original body." }, { uuid: DRAFT_UUID });
    return {
      id: "msg1",
      threadId: "thread1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: '"Me" <me@self.com>' },
          { name: "To", value: "a@b.com" },
          { name: "Cc", value: "c1@x.com" },
          { name: "Subject", value: "Hi" },
          { name: "In-Reply-To", value: "<irt@mail.gmail.com>" },
          { name: "References", value: "<prev@mail.gmail.com>" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url(built.text) } },
              { mimeType: "text/html", body: { data: b64url(built.html) } },
            ],
          },
          {
            mimeType: "application/pdf",
            filename: "report.pdf",
            headers: [{ name: "Content-Disposition", value: 'attachment; filename="report.pdf"' }],
            body: { attachmentId: "att1", size: 2048 },
          },
        ],
      },
    };
  }

  /** Mock the drafts.get / attachments.get / drafts.update round trip; capture the PUT body. */
  function mockDraftRoundTrip(spy: ReturnType<typeof vi.spyOn>, capture: { put?: any }) {
    spy.mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      const method = (init as RequestInit)?.method ?? "GET";
      if (u.includes("/profile")) return new Response(JSON.stringify({ emailAddress: "me@self.com" }), { status: 200 });
      if (u.includes("/settings/sendAs"))
        return new Response(JSON.stringify({ sendAs: [{ sendAsEmail: "me@self.com", displayName: "Me", isPrimary: true }] }), { status: 200 });
      if (u.includes("/attachments/")) return new Response(JSON.stringify({ data: b64url("PDFBYTES"), size: 8 }), { status: 200 });
      if (u.includes("/drafts/") && method === "PUT") {
        capture.put = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify({ id: "draft1", message: { id: "msgNew", threadId: "thread1" } }), { status: 200 });
      }
      if (u.includes("/drafts/")) return new Response(JSON.stringify({ id: "draft1", message: draftMessage() }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }

  it("getDraft parses headers, threadId, the ref uuid and the attachment manifest", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    mockDraftRoundTrip(spy, {});
    const d = await new GmailService({} as any, "get-draft").getDraft("draft1");
    expect(spy.mock.calls[0][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft1?format=full");
    expect(d.draftId).toBe("draft1");
    expect(d.messageId).toBe("msg1");
    expect(d.threadId).toBe("thread1");
    expect(d.headers.cc).toEqual(["c1@x.com"]);
    expect(d.headers.references).toBe("<prev@mail.gmail.com>");
    expect(d.uuid).toBe(DRAFT_UUID);
    expect(d.refCount).toBe(1);
    expect(d.attachments).toEqual([
      { attachmentId: "att1", filename: "report.pdf", mimeType: "application/pdf", size: 2048, disposition: "attachment" },
    ]);
  });

  it("updateDraft addCc adds a Cc while preserving threadId, References and the one ref marker, and keeps the attachment", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cap: { put?: any } = {};
    mockDraftRoundTrip(spy, cap);

    const out = await new GmailService({} as any, "upd-draft").updateDraft("draft1", { addCc: ["c2@y.com"] });

    // Threading is COPIED, never recomputed — the regression this guards against.
    expect(cap.put.message.threadId).toBe("thread1");
    const mime = decodeMime(cap.put.message.raw);
    expect(mime).toContain("Cc: c1@x.com, c2@y.com");
    expect(mime).toContain("References: <prev@mail.gmail.com>");
    expect(mime).toContain("In-Reply-To: <irt@mail.gmail.com>");
    // Exactly one hidden ref marker survives (would be 0 or >1 without the id-preserving compose path).
    expect((mime.match(/ref:[0-9a-f-]{36}/g) ?? []).length).toBe(1);
    // Prior attachment retained, and the body rebuilt through the house standard (not string-spliced).
    expect(mime).toContain('filename="report.pdf"');
    expect(mime).toContain('dir="ltr"');
    expect(out.uuid).toBe(DRAFT_UUID);
    expect(out.threadId).toBe("thread1");
    expect(out.messageId).toBe("msgNew");
  });

  it("updateDraft append keeps the old body and adds the new text after it, still one marker", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cap: { put?: any } = {};
    mockDraftRoundTrip(spy, cap);

    await new GmailService({} as any, "upd-append").updateDraft("draft1", {
      body: { mode: "append", markdown: "P.S. ping me soon." },
    });
    const mime = decodeMime(cap.put.message.raw);
    expect(mime).toContain("Original body.");
    expect(mime).toContain("ping me soon.");
    expect(mime.indexOf("Original body.")).toBeLessThan(mime.indexOf("ping me soon."));
    expect((mime.match(/ref:[0-9a-f-]{36}/g) ?? []).length).toBe(1);
  });

  it("updateDraft replace swaps the body but still preserves the thread", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cap: { put?: any } = {};
    mockDraftRoundTrip(spy, cap);

    await new GmailService({} as any, "upd-replace").updateDraft("draft1", {
      body: { mode: "replace", markdown: "Totally new body." },
    });
    const mime = decodeMime(cap.put.message.raw);
    expect(mime).toContain("Totally new body.");
    expect(mime).not.toContain("Original body.");
    expect(cap.put.message.threadId).toBe("thread1");
    expect((mime.match(/ref:[0-9a-f-]{36}/g) ?? []).length).toBe(1);
  });

  it("updateDraft removeAttachments drops a named attachment", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cap: { put?: any } = {};
    mockDraftRoundTrip(spy, cap);

    await new GmailService({} as any, "upd-rm").updateDraft("draft1", { removeAttachments: ["report.pdf"] });
    const mime = decodeMime(cap.put.message.raw);
    expect(mime).not.toContain('filename="report.pdf"');
  });
});
