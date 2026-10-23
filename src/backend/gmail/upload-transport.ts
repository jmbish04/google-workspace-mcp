/**
 * @fileoverview Gmail send/draft transport that switches between the plain JSON
 * endpoints and the `/upload/gmail/v1` media-upload endpoint.
 *
 * The JSON `messages.send` / `drafts.create` endpoints carry the whole message
 * as a base64url `raw` string inside a JSON body. base64url inflates the MIME
 * by ~33%, so a message approaching Gmail's size ceiling overflows the JSON
 * request long before the message itself is too large — and Gmail answers with
 * an opaque 400. Above a threshold this module uploads the RFC822 bytes
 * directly as a `message/rfc822` part via `uploadType=multipart`, which drops
 * that second base64 layer and lets larger (but still legal) messages through.
 *
 * A precise pre-flight check — measured on the exact RFC822 bytes that will be
 * uploaded — rejects anything over the documented `/upload` ceiling with a
 * clear error instead of a raw Google 400, and rejects an oversized BODY
 * distinctly, because (unlike an attachment) a body cannot be offloaded to a
 * Drive link; the only fix is a shorter body.
 *
 * @remarks
 * Sizes and the ceiling follow the cross-cutting contract owned by the advisor
 * worktree: `docs/gmail-draft-attachment-transport-contract.md` §4
 * (gmail-advisor-harness, commit 905ec0d). The matching attach-vs-link cap is
 * {@link GMAIL_MESSAGE_LIMIT} in `./outgoing-attachments`.
 *
 * @see {@link sendRawMessage}
 * @see {@link createRawDraft}
 */
import { googleJson } from "@/backend/mcp/googleClient";

/** Gmail API host for the JSON (non-upload) endpoints. */
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail API host for the media-upload endpoints (`/upload/gmail/v1`). */
const GMAIL_UPLOAD_BASE = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

/**
 * Hard ceiling for a single outgoing message, in bytes of the RFC822 MIME text
 * (attachments already base64-encoded inside — i.e. the exact bytes uploaded as
 * the `message/rfc822` part). 35 MiB, the documented maximum for the
 * `/upload/gmail/v1` endpoints. A message over this cannot be sent by any
 * transport, so it is rejected pre-flight rather than handed to Google.
 */
export const GMAIL_UPLOAD_MAX_BYTES = 35 * 1024 * 1024;

/**
 * MIME size above which the upload endpoint is used instead of the JSON
 * endpoint. 5 MiB keeps small, common messages on the simpler, well-tested JSON
 * path and only pays the multipart cost when a message is large enough to risk
 * the JSON request-size limit.
 */
export const GMAIL_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * Headroom reserved below {@link GMAIL_UPLOAD_MAX_BYTES} for MIME headers and
 * MIME boundaries when judging whether the BODY alone is too large. A body
 * within this margin of the ceiling leaves no room for headers or attachments,
 * so it is rejected as an oversized body.
 */
export const GMAIL_BODY_HEADROOM_BYTES = 64 * 1024;

/** Format a byte count as MiB with two decimals, for error messages. */
function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Thrown — before any network call — when the whole composed message exceeds
 * {@link GMAIL_UPLOAD_MAX_BYTES}. Carries the measured and limit sizes so the
 * caller can surface a precise, actionable error instead of a raw Google 400.
 */
export class GmailMessageTooLargeError extends Error {
  /**
   * @param messageBytes - measured RFC822 MIME size in bytes
   * @param limitBytes - the ceiling that was exceeded
   */
  constructor(
    public readonly messageBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Message is ${mib(messageBytes)} MiB, over Gmail's ${mib(limitBytes)} MiB send limit. ` +
        `Remove an attachment or send it as a Drive link, then try again.`,
    );
    this.name = "GmailMessageTooLargeError";
  }
}

/**
 * Thrown — before any network call — when the BODY alone is within
 * {@link GMAIL_BODY_HEADROOM_BYTES} of the ceiling. Distinct from
 * {@link GmailMessageTooLargeError}: an oversized body, unlike an oversized
 * attachment, cannot be offloaded to a Drive link, so the only fix is a shorter
 * body and the error says so.
 */
export class GmailBodyTooLargeError extends Error {
  /**
   * @param bodyBytes - measured body (html+text) size in bytes
   * @param limitBytes - the body ceiling (ceiling minus header headroom)
   */
  constructor(
    public readonly bodyBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Email body is ${mib(bodyBytes)} MiB, over the ${mib(limitBytes)} MiB limit for a message body. ` +
        `A body cannot be moved to a Drive link like an attachment can — shorten the body.`,
    );
    this.name = "GmailBodyTooLargeError";
  }
}

/**
 * Exact byte length of the RFC822 MIME text encoded in a base64url `raw` string,
 * computed without allocating the decoded buffer. `raw` is unpadded base64url
 * (Gmail's format), where every 4 characters decode to 3 bytes, so
 * `floor(len * 3 / 4)` is exact for the 0/2/3 remainders base64 can produce.
 *
 * @param raw - base64url-encoded MIME (the Gmail `raw` field)
 * @returns the decoded MIME size in bytes
 */
export function mimeByteLength(raw: string): number {
  return Math.floor((raw.length * 3) / 4);
}

/**
 * Pre-flight size check run before every send and draft so the caller never
 * hits a raw Google 400 for an over-limit message.
 *
 * @param raw - base64url MIME to be sent
 * @param bodyRawBytes - byte length of the composed body (html+text) alone
 * @returns the measured MIME byte length (used to pick the transport)
 * @throws {GmailBodyTooLargeError} when the body alone is too large to ever fit
 * @throws {GmailMessageTooLargeError} when the whole message exceeds the ceiling
 */
export function assertMessageFitsGmail(raw: string, bodyRawBytes: number): number {
  const bodyLimit = GMAIL_UPLOAD_MAX_BYTES - GMAIL_BODY_HEADROOM_BYTES;
  if (bodyRawBytes > bodyLimit) {
    throw new GmailBodyTooLargeError(bodyRawBytes, bodyLimit);
  }
  const messageBytes = mimeByteLength(raw);
  if (messageBytes > GMAIL_UPLOAD_MAX_BYTES) {
    throw new GmailMessageTooLargeError(messageBytes, GMAIL_UPLOAD_MAX_BYTES);
  }
  return messageBytes;
}

/** Decode unpadded base64url to the exact MIME bytes for the upload media part. */
function base64UrlToBytes(raw: string): Uint8Array {
  const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build the `multipart/related` body for a Gmail upload POST: a JSON metadata
 * part followed by the RFC822 message as a `message/rfc822` media part. The
 * body is assembled as bytes so the (possibly UTF-8) MIME is uploaded verbatim,
 * never re-encoded through a JS string.
 *
 * @param raw - base64url MIME; decoded into the media part
 * @param metadata - resource metadata for the JSON part (threadId, draft message, …)
 * @returns the request body bytes and the matching `content-type` header value
 */
function buildMultipartBody(
  raw: string,
  metadata: Record<string, unknown>,
): { body: BodyInit; contentType: string } {
  const boundary = `gmail_upload_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: message/rfc822\r\n\r\n`,
  );
  const mime = base64UrlToBytes(raw);
  const epilogue = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(preamble.length + mime.length + epilogue.length);
  body.set(preamble, 0);
  body.set(mime, preamble.length);
  body.set(epilogue, preamble.length + mime.length);
  // Workers' BodyInit accepts a typed-array view, but tsc's lib types it as
  // Uint8Array<ArrayBuffer>; cast through unknown like the Drive upload helper.
  return { body: body as unknown as BodyInit, contentType: `multipart/related; boundary=${boundary}` };
}

/** Message/draft payload and the body size needed for the oversized-body guard. */
export interface RawTransportInput {
  /** base64url MIME built by `build-outgoing`. */
  raw: string;
  /** Byte length of the composed body (html+text) alone, for the oversized-body guard. */
  bodyRawBytes: number;
  /** Gmail threadId to attach to, when replying. */
  threadId?: string;
}

/**
 * Send a message, choosing the JSON endpoint for small messages and the
 * `/upload/gmail/v1` multipart endpoint above
 * {@link GMAIL_UPLOAD_THRESHOLD_BYTES}. Runs {@link assertMessageFitsGmail}
 * first, so an over-limit message fails with a clear error and no network call.
 *
 * @param env - worker environment (auth + bindings)
 * @param sub - sending account token ref
 * @param input - the raw MIME, its body size, and an optional threadId
 * @returns the created message id (and threadId when Gmail returns one)
 * @throws {GmailBodyTooLargeError} | {GmailMessageTooLargeError} pre-flight
 */
export async function sendRawMessage(
  env: Env,
  sub: string,
  input: RawTransportInput,
): Promise<{ id: string; threadId?: string }> {
  const messageBytes = assertMessageFitsGmail(input.raw, input.bodyRawBytes);
  if (messageBytes <= GMAIL_UPLOAD_THRESHOLD_BYTES) {
    const payload: { raw: string; threadId?: string } = { raw: input.raw };
    if (input.threadId) payload.threadId = input.threadId;
    return googleJson<{ id: string; threadId?: string }>(env, sub, `${GMAIL_BASE}/messages/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  const metadata: Record<string, unknown> = input.threadId ? { threadId: input.threadId } : {};
  const { body, contentType } = buildMultipartBody(input.raw, metadata);
  return googleJson<{ id: string; threadId?: string }>(
    env,
    sub,
    `${GMAIL_UPLOAD_BASE}/messages/send?uploadType=multipart`,
    {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    },
  );
}

/**
 * Create a draft, choosing JSON vs `/upload/gmail/v1` multipart exactly like
 * {@link sendRawMessage}. Runs {@link assertMessageFitsGmail} first.
 *
 * @param env - worker environment (auth + bindings)
 * @param sub - sending account token ref
 * @param input - the raw MIME, its body size, and an optional threadId
 * @returns the created draft id (and its message when Gmail returns one)
 * @throws {GmailBodyTooLargeError} | {GmailMessageTooLargeError} pre-flight
 */
export async function createRawDraft(
  env: Env,
  sub: string,
  input: RawTransportInput,
): Promise<{ id: string; message?: { id: string; threadId?: string } }> {
  const messageBytes = assertMessageFitsGmail(input.raw, input.bodyRawBytes);
  if (messageBytes <= GMAIL_UPLOAD_THRESHOLD_BYTES) {
    const message: { raw: string; threadId?: string } = { raw: input.raw };
    if (input.threadId) message.threadId = input.threadId;
    return googleJson<{ id: string; message?: { id: string; threadId?: string } }>(
      env,
      sub,
      `${GMAIL_BASE}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({ message }),
      },
    );
  }
  const metadata: Record<string, unknown> = {
    message: input.threadId ? { threadId: input.threadId } : {},
  };
  const { body, contentType } = buildMultipartBody(input.raw, metadata);
  return googleJson<{ id: string; message?: { id: string; threadId?: string } }>(
    env,
    sub,
    `${GMAIL_UPLOAD_BASE}/drafts?uploadType=multipart`,
    {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    },
  );
}
