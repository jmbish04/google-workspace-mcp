/**
 * @fileoverview Send one Docs batch and return a typed result, never a raw
 * Google 400.
 *
 * Every write tool of the batch-first engine (`docs_batch_update`,
 * `docs_set_page_setup`, `docs_build_from_spec`, `docs_patch`) goes through
 * {@link runBatch}: it passes `writeControl` through, reads the new revision id
 * from the response, and turns a Google rejection into a {@link BatchError}
 * (revision conflict, failing request index, refused write mode).
 *
 * @example
 * ```typescript
 * import { runBatch } from "@/backend/docs/batch-runner";
 * const out = await runBatch(docs, id, requests, { requiredRevisionId: raw.revisionId });
 * if (!out.ok) return { result: out };
 * ```
 */
import { classifyBatchError, type BatchError } from "@/backend/docs/batch-errors";
import type { BatchUpdateResponse, DocsService, DocsWriteControl } from "@/backend/mcp/services/docs";

/** A batch Google applied. */
export interface BatchSuccess {
  ok: true;
  documentId: string;
  replies: unknown[];
  /** Revision id after the batch, from the response `writeControl`; null when Google sent none. */
  revisionId: string | null;
  requestCount: number;
}

/** Result of {@link runBatch}. */
export type BatchResult = BatchSuccess | BatchError;

/**
 * Apply `requests` atomically and report the outcome.
 *
 * @param docs - a DocsService bound to the acting account
 * @param documentId - bare doc id or Docs URL
 * @param requests - Docs API request objects
 * @param writeControl - optional guard / write mode, passed through unchanged
 * @returns `{ ok:true, replies, revisionId, requestCount }` or a typed {@link BatchError}
 * @throws whatever the transport throws that is not a Google API error (network, auth)
 */
export async function runBatch(
  docs: DocsService,
  documentId: string,
  requests: unknown[],
  writeControl?: DocsWriteControl,
): Promise<BatchResult> {
  try {
    const res = await docs.batchUpdate<BatchUpdateResponse>(documentId, requests, writeControl);
    return {
      ok: true,
      documentId: res?.documentId ?? documentId,
      replies: res?.replies ?? [],
      revisionId: res?.writeControl?.requiredRevisionId ?? null,
      requestCount: requests.length,
    };
  } catch (err) {
    const typed = classifyBatchError(err, { requestCount: requests.length, writeMode: writeControl?.writeMode });
    if (typed) return typed;
    throw err;
  }
}
