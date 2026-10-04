/**
 * @fileoverview Structured and D1-mirrored telemetry for document APIs.
 *
 * The synchronous JSON log supports Workers Logs while the existing mcp_logs
 * table supplies the repository's mirrored D1 operational history.
 */
import { logOperation } from "@/backend/mcp/logging";

/**
 * Emit one structured event and asynchronously mirror it to D1.
 * @param env - Worker bindings.
 * @param ctx - Request execution context.
 * @param event - Stable operation name.
 * @param success - Whether the operation succeeded.
 * @param latencyMs - Wall-clock duration.
 * @param detail - Non-secret identifiers and counts.
 * @returns Nothing.
 */
export function recordDocumentOperation(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  event: string,
  success: boolean,
  latencyMs: number,
  detail: Record<string, unknown> = {},
): void {
  console.info(
    JSON.stringify({ service: "document-persistence", event, success, latencyMs, ...detail }),
  );
  ctx.waitUntil(
    logOperation(env, {
      toolName: `document_api.${event}`,
      request: detail,
      success,
      latencyMs,
    }).catch((error) =>
      console.error(
        JSON.stringify({
          service: "document-persistence",
          event: "telemetry_error",
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );
}
