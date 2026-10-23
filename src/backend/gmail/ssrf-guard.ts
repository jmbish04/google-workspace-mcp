/**
 * @fileoverview SSRF guard + bounded fetch for outgoing-email `{ url }` attachments.
 *
 * The Worker fetches caller-supplied URLs server-side, so every request is
 * checked before it leaves: https only, no embedded credentials, default port
 * only, no private / loopback / link-local / CGNAT / cloud-metadata targets, and
 * (default on) the hostname's A/AAAA records are resolved over DNS-over-HTTPS and
 * every address must be public. Redirects are followed MANUALLY and each hop is
 * re-validated. The body is streamed with a hard byte cap.
 *
 * Residual risk (documented, not hidden): `fetch()` resolves DNS again itself, so
 * a hostile resolver could answer differently between our check and the fetch
 * (DNS rebinding). Workers also cannot dial RFC1918 space, which bounds the blast
 * radius, but this guard does not rely on that.
 *
 * @example
 * ```typescript
 * import { fetchPublicHttps } from "@/backend/gmail/ssrf-guard";
 * const { bytes, contentType } = await fetchPublicHttps("https://example.com/a.pdf");
 * ```
 */

/** Hard ceiling on bytes fetched for one url attachment (memory guard, before Drive overflow upload). */
export const MAX_URL_FETCH_BYTES = 32 * 1024 * 1024;
/** Max redirect hops followed (each re-validated). */
export const MAX_REDIRECTS = 3;
/** Whole-request timeout (all hops + body) in milliseconds. */
export const URL_FETCH_TIMEOUT_MS = 20_000;

/** Thrown for every refusal so callers can tell a blocked URL from a network fault. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(`url attachment refused: ${message}`);
    this.name = "SsrfBlockedError";
  }
}

/** Refusal subclass: the body exceeded the byte cap (lets callers fall back to a link instead of failing). */
export class FetchTooLargeError extends SsrfBlockedError {
  constructor(message: string) {
    super(message);
    this.name = "FetchTooLargeError";
  }
}

/** Resolves a hostname to its A + AAAA addresses. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** Options for {@link fetchPublicHttps}. */
export interface FetchPublicOptions {
  /** Override DNS resolution (tests). Default: Cloudflare DNS-over-HTTPS. */
  resolve?: HostResolver;
  /** Override fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Byte cap; default {@link MAX_URL_FETCH_BYTES}. */
  maxBytes?: number;
}

/** Result of a successful guarded fetch. */
export interface FetchedBytes {
  bytes: Uint8Array;
  contentType?: string;
  /** Filename from Content-Disposition, if the server sent one. */
  dispositionFilename?: string;
  /** Final URL (after redirects) with query/hash removed — safe to log or report. */
  finalUrl: string;
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** True when an IPv4 dotted quad is NOT a public unicast address. */
export function isBlockedIPv4(host: string): boolean {
  const o = parseIPv4(host);
  if (!o) return true; // unparseable → fail closed
  const [a, b, c] = o;
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (also Alibaba metadata 100.100.100.200)
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol + TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal (no brackets, no zone) into 8 16-bit groups, or null if malformed. */
function parseIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  // Trailing dotted-quad (::ffff:1.2.3.4) → two hex groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    h = h.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** True when an IPv6 literal is NOT a public global-unicast address (or embeds a blocked IPv4). */
export function isBlockedIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return true; // fail closed
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(8) || (allZeroTo(7) && g[7] === 1)) return true; // :: and ::1
  if (allZeroTo(5) && g[5] === 0xffff) return isBlockedIPv4(embedded(g[6], g[7])); // ::ffff:a.b.c.d
  if (allZeroTo(6)) return true; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(embedded(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique-local (incl. AWS fd00:ec2::254)
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
    g[0] === 0x0100 // 100::/64 discard
  );
}

/** Hostnames refused outright regardless of what they resolve to. */
function isBlockedHostname(host: string): boolean {
  const h = host.replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") || // metadata.google.internal, *.internal
    h.endsWith(".localdomain") ||
    h.endsWith(".home.arpa") ||
    h === "metadata" ||
    !h.includes(".") // bare single-label names resolve via search domains
  );
}

/**
 * Validate a URL string WITHOUT touching the network: https only, no userinfo,
 * default port, and a host that is neither a blocked name nor a blocked IP literal.
 *
 * @param raw - caller-supplied URL
 * @returns the parsed URL
 * @throws {SsrfBlockedError} on any violation
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError("not a valid URL");
  }
  if (u.protocol !== "https:") throw new SsrfBlockedError(`scheme "${u.protocol.replace(":", "")}" is not allowed (https only)`);
  if (u.username || u.password) throw new SsrfBlockedError("credentials in the URL are not allowed");
  if (u.port && u.port !== "443") throw new SsrfBlockedError(`port ${u.port} is not allowed (443 only)`);
  // WHATWG URL already canonicalises decimal/hex/octal IPv4 (http://2130706433/) to dotted form.
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[")) {
    if (isBlockedIPv6(host.slice(1, -1))) throw new SsrfBlockedError("IPv6 address is private, loopback, link-local or reserved");
  } else if (parseIPv4(host)) {
    if (isBlockedIPv4(host)) throw new SsrfBlockedError("IPv4 address is private, loopback, link-local, metadata or reserved");
  } else if (isBlockedHostname(host)) {
    throw new SsrfBlockedError(`host "${host}" is not a public hostname`);
  }
  return u;
}

/** Default resolver: Cloudflare DNS-over-HTTPS, A + AAAA. Throws if neither answers. */
const dohResolve: HostResolver = async (hostname) => {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!r.ok) throw new SsrfBlockedError(`DNS lookup for ${hostname} failed (${r.status})`);
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if (a.type === (type === "A" ? 1 : 28)) out.push(a.data);
  }
  return out;
};

async function assertHostResolvesPublic(host: string, resolve: HostResolver): Promise<void> {
  if (host.startsWith("[") || parseIPv4(host)) return; // literal already checked
  const addrs = await resolve(host);
  if (!addrs.length) throw new SsrfBlockedError(`host "${host}" did not resolve`);
  for (const a of addrs) {
    if (a.includes(":") ? isBlockedIPv6(a) : isBlockedIPv4(a)) {
      throw new SsrfBlockedError(`host "${host}" resolves to a non-public address`);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new FetchTooLargeError(`response is ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchTooLargeError(`response exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function dispositionName(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(h);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(h);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

/**
 * GET a public https URL with SSRF protection, manual redirect re-validation,
 * a timeout, and a streaming byte cap.
 *
 * @param rawUrl - caller-supplied URL
 * @param opts - test seams + byte cap
 * @returns the body bytes plus content metadata
 * @throws {SsrfBlockedError} if any hop is refused, the body is too large, or the response is not 2xx
 */
export async function fetchPublicHttps(rawUrl: string, opts: FetchPublicOptions = {}): Promise<FetchedBytes> {
  const doFetch = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? dohResolve;
  const maxBytes = opts.maxBytes ?? MAX_URL_FETCH_BYTES;
  const signal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS);
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = assertPublicHttpsUrl(current);
    await assertHostResolvesPublic(u.hostname.toLowerCase(), resolve);
    const res = await doFetch(u.toString(), { redirect: "manual", signal, headers: { accept: "*/*" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new SsrfBlockedError(`redirect (${res.status}) without a Location header`);
      current = new URL(loc, u).toString(); // re-validated at the top of the next hop
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SsrfBlockedError(`fetch returned HTTP ${res.status}`);
    }
    const bytes = await readCapped(res, maxBytes);
    return {
      bytes,
      contentType: res.headers.get("content-type")?.split(";")[0].trim() || undefined,
      dispositionFilename: dispositionName(res.headers.get("content-disposition")),
      finalUrl: `${u.origin}${u.pathname}`,
    };
  }
  throw new SsrfBlockedError(`more than ${MAX_REDIRECTS} redirects`);
}
