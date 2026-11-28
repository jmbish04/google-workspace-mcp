/**
 * @fileoverview Typed results for a failed Google Docs `documents.batchUpdate`.
 *
 * `googleFetch` throws a {@link GoogleApiError} whose `body` is Google's raw
 * JSON error. Surfacing that as "Google API 400: {...}" tells an agent nothing
 * it can act on. This module turns it into a small typed object:
 *
 * - `REVISION_CONFLICT` — the batch was pinned with
 *   `writeControl.requiredRevisionId` and the document moved after the read.
 *   Nothing was applied; the agent must read again and rebuild its indices.
 * - `UNKNOWN_REQUEST_TYPE` — a request object names a type Google does not know
 *   (`Unknown name "x" at 'requests[N]'`).
 * - `INVALID_REQUEST` — Google rejected one request (`Invalid requests[N].type: …`).
 * - `WRITE_MODE_REFUSED` — Google refused `writeControl.writeMode` (SUGGEST is a
 *   Developer Preview feature).
 * - `GOOGLE_ERROR` — anything else; Google's own message is still kept.
 *
 * Google's message text is always kept verbatim in `googleMessage`, and the
 * failing request index is parsed out of it whenever Google names one.
 *
 * @example
 * ```typescript
 * try { await docs.batchUpdate(id, requests, wc); }
 * catch (err) {
 *   const typed = classifyBatchError(err, { requestCount: requests.length });
 *   if (typed) return { result: typed };
 *   throw err;
 * }
 * ```
 */
import { GoogleApiError } from "@/backend/mcp/googleClient";

/** Machine-readable failure class of a batchUpdate. */
export type BatchErrorCode =
  | "REVISION_CONFLICT"
  | "UNKNOWN_REQUEST_TYPE"
  | "INVALID_REQUEST"
  | "WRITE_MODE_REFUSED"
  | "GOOGLE_ERROR";

/** The typed failure a Docs write tool returns instead of a raw Google 400. */
export interface BatchError {
  ok: false;
  code: BatchErrorCode;
  /** One readable sentence for the agent; includes Google's text when it helps. */
  message: string;
  /** HTTP status Google answered with. */
  status: number;
  /** Google's `error.status` (e.g. `INVALID_ARGUMENT`), when present. */
  googleStatus?: string;
  /** Google's own message, verbatim. */
  googleMessage: string;
  /** Zero-based index of the failing request, when Google names it. */
  requestIndex?: number;
  /** The failing request's type key (e.g. `insertText`), when Google names it. */
  requestType?: string;
  /** How many requests the rejected batch carried (none were applied). */
  requestCount: number;
  /** Extra advice, e.g. for a SUGGEST batch. */
  hint?: string;
}

/** Message the agent gets for a stale `requiredRevisionId`. */
export const REVISION_CONFLICT_MESSAGE =
  "The document changed after your read. Read it again and rebuild the requests.";

const SUGGEST_HINT =
  "writeMode SUGGEST is a Google Developer Preview feature; Google refuses it for projects that are not enrolled. Retry without writeMode to apply the changes as normal edits.";

/**
 * Whether a caught value is Google rejecting a pinned `requiredRevisionId`.
 *
 * @param err - the value caught from a batchUpdate call
 * @returns true only for a 400 `GoogleApiError` whose body has `error.status === "FAILED_PRECONDITION"`
 */
export function isRevisionConflict(err: unknown): boolean {
  if (!(err instanceof GoogleApiError) || err.status !== 400) return false;
  return parseGoogleBody(err.body).status === "FAILED_PRECONDITION";
}

/** Google's `{ error: { status, message } }`, or the raw body as the message. */
function parseGoogleBody(body: string): { status?: string; message: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { status?: string; message?: string } };
    if (parsed?.error) return { status: parsed.error.status, message: parsed.error.message ?? body };
  } catch {
    /* not JSON — fall through */
  }
  return { message: body };
}

/**
 * Turn a caught batchUpdate failure into a typed {@link BatchError}.
 *
 * @param err - the value caught from `DocsService.batchUpdate`
 * @param ctx - `requestCount` of the rejected batch, and the `writeMode` it was sent with
 * @returns the typed error, or null when `err` is not a Google API error (rethrow it)
 * @example
 * classifyBatchError(new GoogleApiError(400, '{"error":{"status":"FAILED_PRECONDITION","message":"…"}}'), { requestCount: 2 })
 * // → { ok:false, code:"REVISION_CONFLICT", … }
 */
export function classifyBatchError(
  err: unknown,
  ctx: { requestCount: number; writeMode?: string },
): BatchError | null {
  if (!(err instanceof GoogleApiError)) return null;
  const { status: googleStatus, message: googleMessage } = parseGoogleBody(err.body);
  const base = {
    ok: false as const,
    status: err.status,
    googleStatus,
    googleMessage,
    requestCount: ctx.requestCount,
  };
  const suggest = ctx.writeMode === "SUGGEST";

  if (err.status === 400 && googleStatus === "FAILED_PRECONDITION") {
    return { ...base, code: "REVISION_CONFLICT", message: REVISION_CONFLICT_MESSAGE };
  }

  if (ctx.writeMode && /write_?mode/i.test(googleMessage)) {
    return {
      ...base,
      code: "WRITE_MODE_REFUSED",
      message: `Google refused writeMode ${ctx.writeMode}; nothing was applied. Google said: ${googleMessage}`,
      ...(suggest ? { hint: SUGGEST_HINT } : {}),
    };
  }

  const unknown = /Unknown name "([^"]+)" at 'requests\[(\d+)\]'/.exec(googleMessage);
  if (unknown) {
    return {
      ...base,
      code: "UNKNOWN_REQUEST_TYPE",
      requestIndex: Number(unknown[2]),
      requestType: unknown[1],
      message: `requests[${unknown[2]}] uses an unknown request type "${unknown[1]}"; nothing was applied. Google said: ${googleMessage}`,
    };
  }

  const invalid = /requests\[(\d+)\](?:\.(\w+))?/.exec(googleMessage);
  if (invalid) {
    return {
      ...base,
      code: "INVALID_REQUEST",
      requestIndex: Number(invalid[1]),
      ...(invalid[2] ? { requestType: invalid[2] } : {}),
      message: `Google rejected requests[${invalid[1]}]; nothing was applied. Google said: ${googleMessage}`,
    };
  }

  return {
    ...base,
    code: "GOOGLE_ERROR",
    message: `Google refused the batch (HTTP ${err.status}); nothing was applied. Google said: ${googleMessage}`,
    ...(suggest ? { hint: SUGGEST_HINT } : {}),
  };
}
