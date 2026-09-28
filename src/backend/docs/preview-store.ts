/**
 * @file docs/preview-store.ts
 * @description Short-lived doc-preview storage on a DEDICATED R2 bucket
 * (R2_PREVIEWS_BUCKET → `google-workspace-mcp-previews`), served by the worker at
 * `/api/preview/:id`. The bucket has a lifecycle rule ("expire-48h") that
 * auto-deletes every object after 2 days, so TTL is automatic — no per-object
 * bookkeeping. Objects are keyed by a self-describing id (`{uuid}-p1.png`,
 * `{uuid}.pdf`) so the serve route can infer the content-type. No DB row.
 *
 * {@link purgeExpiredPreviews} is a belt-and-suspenders sweep on the hourly cron
 * (exact 48h) in case the lifecycle rule is ever removed; the lifecycle rule is
 * the primary mechanism.
 */
export const PREVIEW_TTL_MS = 48 * 60 * 60 * 1000;

/** Store one preview object (PNG or PDF) and return its servable worker URL. */
export async function putPreview(
  env: Env,
  id: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  await env.R2_PREVIEWS_BUCKET.put(id, bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType },
  });
  return `/api/preview/${id}`;
}

/** Content-type for a preview id, inferred from its extension. */
export function previewContentType(id: string): string {
  if (id.endsWith(".pdf")) return "application/pdf";
  if (id.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/**
 * Delete preview objects older than 48h. Returns the count removed. Belt for the
 * bucket lifecycle rule; runs on the hourly cron and paginates the whole bucket.
 */
export async function purgeExpiredPreviews(env: Env): Promise<number> {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  let removed = 0;
  let cursor: string | undefined;
  do {
    const list = await env.R2_PREVIEWS_BUCKET.list({ cursor, limit: 1000 });
    const stale = list.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
    for (const key of stale) {
      await env.R2_PREVIEWS_BUCKET.delete(key);
      removed++;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return removed;
}
