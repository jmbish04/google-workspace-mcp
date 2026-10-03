import { describe, it, expect, vi, afterEach } from "vitest";
import { GmailService } from "../gmail";
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
});
