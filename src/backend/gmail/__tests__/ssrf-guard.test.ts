import { describe, it, expect } from "vitest";
import { assertPublicHttpsUrl, fetchPublicHttps, SsrfBlockedError, isBlockedIPv4, isBlockedIPv6 } from "@/backend/gmail/ssrf-guard";

const publicDns = async () => ["93.184.216.34"];
const ok = (body = "hi", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

describe("assertPublicHttpsUrl", () => {
  const blocked = [
    "http://example.com/a.pdf", // plain http
    "ftp://example.com/a",
    "file:///etc/passwd",
    "https://user:pw@example.com/a",
    "https://example.com:8443/a",
    "https://127.0.0.1/a",
    "https://127.1.2.3/a",
    "https://10.0.0.5/a",
    "https://172.16.0.1/a",
    "https://172.31.255.255/a",
    "https://192.168.1.1/a",
    "https://169.254.169.254/latest/meta-data/", // AWS/GCP/Azure metadata
    "https://100.100.100.200/", // Alibaba metadata (CGNAT)
    "https://0.0.0.0/a",
    "https://2130706433/a", // decimal 127.0.0.1
    "https://0x7f000001/a", // hex 127.0.0.1
    "https://0177.0.0.1/a", // octal 127.0.0.1
    "https://[::1]/a",
    "https://[::ffff:127.0.0.1]/a", // v4-mapped loopback
    "https://[::ffff:169.254.169.254]/a",
    "https://[fd00:ec2::254]/a", // AWS IPv6 metadata
    "https://[fe80::1]/a",
    "https://[64:ff9b::7f00:1]/a", // NAT64 → 127.0.0.1
    "https://localhost/a",
    "https://foo.localhost/a",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/a",
    "https://intranet/a", // single-label
    "not a url",
  ];
  for (const u of blocked) {
    it(`refuses ${u}`, () => {
      expect(() => assertPublicHttpsUrl(u)).toThrow(SsrfBlockedError);
    });
  }

  it("allows a public https URL, default port", () => {
    expect(assertPublicHttpsUrl("https://example.com/a.pdf?sig=1").hostname).toBe("example.com");
    expect(assertPublicHttpsUrl("https://example.com:443/a").hostname).toBe("example.com");
    expect(assertPublicHttpsUrl("https://[2606:4700:4700::1111]/a").hostname).toBe("[2606:4700:4700::1111]");
  });

  it("classifies boundary addresses", () => {
    expect(isBlockedIPv4("172.15.255.255")).toBe(false);
    expect(isBlockedIPv4("172.32.0.0")).toBe(false);
    expect(isBlockedIPv4("100.63.255.255")).toBe(false);
    expect(isBlockedIPv4("8.8.8.8")).toBe(false);
    expect(isBlockedIPv6("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedIPv6("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("fetchPublicHttps", () => {
  it("returns bytes + metadata and strips the query from finalUrl", async () => {
    const r = await fetchPublicHttps("https://example.com/files/r.pdf?X-Sig=secret", {
      resolve: publicDns,
      fetchImpl: async () => ok("abc", { "content-type": "application/pdf; charset=x", "content-disposition": 'attachment; filename="Report.pdf"' }),
    });
    expect(new TextDecoder().decode(r.bytes)).toBe("abc");
    expect(r.contentType).toBe("application/pdf");
    expect(r.dispositionFilename).toBe("Report.pdf");
    expect(r.finalUrl).toBe("https://example.com/files/r.pdf");
  });

  it("refuses a public-looking host whose DNS answers a private address (and never fetches)", async () => {
    let fetched = false;
    await expect(
      fetchPublicHttps("https://evil.example.com/a", {
        resolve: async () => ["10.0.0.7"],
        fetchImpl: async () => ((fetched = true), ok()),
      }),
    ).rejects.toThrow(/non-public address/);
    expect(fetched).toBe(false);
  });

  it("refuses when ANY resolved address is private (mixed A/AAAA)", async () => {
    await expect(
      fetchPublicHttps("https://evil.example.com/a", { resolve: async () => ["93.184.216.34", "::1"], fetchImpl: async () => ok() }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("re-validates every redirect hop (public → metadata IP)", async () => {
    const calls: string[] = [];
    await expect(
      fetchPublicHttps("https://example.com/a", {
        resolve: publicDns,
        fetchImpl: async (u) => {
          calls.push(String(u));
          return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
        },
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(calls).toEqual(["https://example.com/a"]); // the metadata hop was never requested
  });

  it("refuses a redirect downgrade to http", async () => {
    await expect(
      fetchPublicHttps("https://example.com/a", {
        resolve: publicDns,
        fetchImpl: async () => new Response(null, { status: 301, headers: { location: "http://example.com/b" } }),
      }),
    ).rejects.toThrow(/https only/);
  });

  it("follows a safe redirect", async () => {
    let n = 0;
    const r = await fetchPublicHttps("https://example.com/a", {
      resolve: publicDns,
      fetchImpl: async () => (n++ === 0 ? new Response(null, { status: 302, headers: { location: "/b.txt" } }) : ok("done")),
    });
    expect(new TextDecoder().decode(r.bytes)).toBe("done");
    expect(r.finalUrl).toBe("https://example.com/b.txt");
  });

  it("stops redirect loops", async () => {
    await expect(
      fetchPublicHttps("https://example.com/a", {
        resolve: publicDns,
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://example.com/a" } }),
      }),
    ).rejects.toThrow(/redirects/);
  });

  it("enforces the byte cap on a streamed body with no Content-Length", async () => {
    await expect(
      fetchPublicHttps("https://example.com/a", { resolve: publicDns, maxBytes: 4, fetchImpl: async () => ok("0123456789") }),
    ).rejects.toThrow(/limit/);
  });

  it("rejects non-2xx", async () => {
    await expect(
      fetchPublicHttps("https://example.com/a", { resolve: publicDns, fetchImpl: async () => new Response("no", { status: 404 }) }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
