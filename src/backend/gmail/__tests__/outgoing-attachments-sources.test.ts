import { describe, it, expect, vi, beforeEach } from "vitest";

const uploadCalls: string[] = [];
vi.mock("@/backend/mcp/services/drive", () => ({
  DriveService: class {
    async uploadBinary(name: string) {
      uploadCalls.push(name);
      return { id: `up_${name}`, name, webViewLink: `https://drive/up_${name}` };
    }
    async share() {
      return {};
    }
  },
}));

const { resolveAttachments, GMAIL_MESSAGE_LIMIT } = await import("../outgoing-attachments");

const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
const env = {
  R2_FILES_BUCKET: {
    get: async (key: string) => {
      const o = objects.get(key);
      return o ? { arrayBuffer: async () => o.body.buffer.slice(0), httpMetadata: { contentType: o.contentType } } : null;
    },
  },
} as unknown as Env;
const publicDns = async () => ["93.184.216.34"];

beforeEach(() => {
  uploadCalls.length = 0;
  objects.clear();
});

describe("resolveAttachments: url source", () => {
  it("attaches a fetched https file as a real MIME part", async () => {
    const r = await resolveAttachments(env, "ref", [{ url: "https://example.com/dl/report.pdf?sig=abc" }], 0, {
      resolve: publicDns,
      fetchImpl: async () => new Response("PDFBYTES", { headers: { "content-type": "application/pdf" } }),
    });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ filename: "report.pdf", mimeType: "application/pdf" });
    expect(new TextDecoder().decode(r.attachments[0].bytes)).toBe("PDFBYTES");
    expect(r.report[0]).toMatchObject({ source: "url", disposition: "attached", ref: "https://example.com/dl/report.pdf" });
    expect(r.report[0].ref).not.toContain("sig=");
    expect(r.links).toHaveLength(0);
  });

  it("refuses private and metadata targets and attaches nothing", async () => {
    let fetched = false;
    const opts = { resolve: publicDns, fetchImpl: async () => ((fetched = true), new Response("x")) };
    for (const url of ["https://169.254.169.254/latest/meta-data/", "https://10.1.2.3/x", "http://example.com/x", "https://localhost/x"]) {
      await expect(resolveAttachments(env, "ref", [{ url }], 0, opts)).rejects.toThrow(/url attachment refused/);
    }
    expect(fetched).toBe(false);
  });

  it("over-budget url file is linked AS-IS: no Drive copy, original url in links + report", async () => {
    const r = await resolveAttachments(env, "ref", [{ url: "https://example.com/big.bin?sig=1" }], GMAIL_MESSAGE_LIMIT, {
      resolve: publicDns,
      fetchImpl: async () => new Response("some bytes"),
    });
    expect(r.attachments).toHaveLength(0);
    expect(uploadCalls).toEqual([]);
    expect(r.links[0]).toEqual({ name: "big.bin", url: "https://example.com/big.bin?sig=1" });
    expect(r.report[0]).toMatchObject({ source: "url", disposition: "linked-over-limit", ref: "https://example.com/big.bin?sig=1" });
  });

  it("a body larger than the remaining budget is cut off while streaming and linked as-is", async () => {
    const used = GMAIL_MESSAGE_LIMIT - 4 * 1024; // ~3 KiB raw headroom
    const r = await resolveAttachments(env, "ref", [{ url: "https://example.com/huge.bin" }], used, {
      resolve: publicDns,
      fetchImpl: async () => new Response(new Uint8Array(1024 * 1024)), // 1 MiB, no trustworthy length
    });
    expect(r.attachments).toHaveLength(0);
    expect(r.report[0].disposition).toBe("linked-over-limit");
    expect(uploadCalls).toEqual([]);
  });

  it("as:'link' links the url as-is WITHOUT fetching it", async () => {
    let fetched = false;
    const r = await resolveAttachments(env, "ref", [{ url: "https://example.com/a.txt", as: "link" }], 0, {
      resolve: publicDns,
      fetchImpl: async () => ((fetched = true), new Response("t")),
    });
    expect(fetched).toBe(false);
    expect(uploadCalls).toEqual([]);
    expect(r.links[0].url).toBe("https://example.com/a.txt");
    expect(r.report[0].disposition).toBe("linked-by-request");
  });

  it("as:'link' still refuses a non-public url", async () => {
    await expect(resolveAttachments(env, "ref", [{ url: "https://169.254.169.254/x", as: "link" }])).rejects.toThrow(/url attachment refused/);
  });

  it("rejects an item carrying two source keys", async () => {
    await expect(
      resolveAttachments(env, "ref", [{ url: "https://example.com/a", r2Key: "k" } as never]),
    ).rejects.toThrow(/exactly one of/);
  });
});

describe("resolveAttachments: r2Key source", () => {
  it("attaches an R2 object with its stored content type and key-derived filename", async () => {
    objects.set("uploads/2026/invoice.pdf", { body: new TextEncoder().encode("R2BYTES"), contentType: "application/pdf" });
    const r = await resolveAttachments(env, "ref", [{ r2Key: "uploads/2026/invoice.pdf" }]);
    expect(r.attachments[0]).toMatchObject({ filename: "invoice.pdf", mimeType: "application/pdf" });
    expect(new TextDecoder().decode(r.attachments[0].bytes)).toBe("R2BYTES");
    expect(r.report[0]).toMatchObject({ source: "r2", ref: "uploads/2026/invoice.pdf", disposition: "attached" });
  });

  it("explicit filename/mimeType override object metadata", async () => {
    objects.set("k", { body: new Uint8Array([1]), contentType: "application/pdf" });
    const r = await resolveAttachments(env, "ref", [{ r2Key: "k", filename: "x.bin", mimeType: "text/plain" }]);
    expect(r.attachments[0]).toMatchObject({ filename: "x.bin", mimeType: "text/plain" });
  });

  it("throws a clear error for a missing key", async () => {
    await expect(resolveAttachments(env, "ref", [{ r2Key: "nope" }])).rejects.toThrow(/not found in R2_FILES_BUCKET: nope/);
  });

  it("over-budget r2 object overflows to a Drive link", async () => {
    objects.set("big.zip", { body: new Uint8Array([1, 2, 3]) });
    const r = await resolveAttachments(env, "ref", [{ r2Key: "big.zip" }], GMAIL_MESSAGE_LIMIT);
    expect(r.report[0]).toMatchObject({ source: "r2", disposition: "linked-over-limit" });
    expect(uploadCalls).toEqual(["big.zip"]);
  });
});
