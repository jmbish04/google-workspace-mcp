/**
 * @file mcp/tool-runner.ts
 * @description The single chokepoint every MCP tool invocation flows through
 * (both the `/mcp` JSON-RPC dispatch and the code-mode `callTool` RPC). It layers
 * three cross-cutting behaviours onto a raw `tool.run`:
 *
 *  1. Input sanitization — repair mojibake / HTML-entity slop on content fields
 *     (see {@link sanitizeArgs}).
 *  2. Primary execution — the tool's own logic.
 *  3. Mandatory cross-account shadow search — for read-only tools, re-run the
 *     same read in every OTHER registered account and attach an `_shadowSearch`
 *     FYI so the model can self-correct when it targeted the wrong account.
 *
 * Shadow search must never break or slow the primary result into failure: every
 * shadow branch is wrapped so its errors become informational, not fatal.
 */
import { acct, SHADOW_TOOLS, type ToolCtx, type ToolDef, type ToolAsset } from "./tools";
import { sanitizeArgs } from "./text-sanitize";
import { listCaptureAccounts, accountEmailFor } from "@/backend/gmail/sync-service";

/** Per-account outcome of a shadow read. */
type ShadowHit = { account: string; hit: boolean; count?: number; error?: string };

/** FYI block attached to a read tool's result describing hits in other accounts. */
type ShadowSearch = {
  note: string;
  targetAccount: string;
  otherAccounts: ShadowHit[];
};

/** Cap on how many other accounts a single call will shadow (latency / subrequest budget). */
const MAX_SHADOW_ACCOUNTS = 5;

/**
 * Reduce a shadow tool result to a hit summary. Heuristic: the first array-valued
 * property is the result set (files/messages/permissions/events/…); a plain object
 * with no array is a successful single lookup (a "hit").
 */
function summarize(result: unknown): { hit: boolean; count?: number } {
  if (Array.isArray(result)) return { hit: result.length > 0, count: result.length };
  if (result && typeof result === "object") {
    for (const v of Object.values(result as Record<string, unknown>)) {
      if (Array.isArray(v)) return { hit: v.length > 0, count: v.length };
    }
    return { hit: true };
  }
  return { hit: result != null };
}

/** Attach the shadow FYI without clobbering the primary result's own shape. */
function withShadow(result: unknown, shadow: ShadowSearch): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), _shadowSearch: shadow };
  }
  return { result, _shadowSearch: shadow };
}

/** Run the same read in each other account and summarize. Errors → informational entries. */
async function computeShadow(
  tool: ToolDef,
  ctx: ToolCtx,
  args: Record<string, unknown>,
): Promise<ShadowSearch | null> {
  const targetEmail = await accountEmailFor(ctx.env, acct(ctx.sub, args));
  const accounts = await listCaptureAccounts(ctx.env);
  const others = accounts.filter((x) => x.email !== targetEmail).slice(0, MAX_SHADOW_ACCOUNTS);
  if (others.length === 0) return null;

  const otherAccounts = await Promise.all(
    others.map(async (o): Promise<ShadowHit> => {
      try {
        // Re-target by email via as_user; call tool.run directly so we don't
        // recurse back through the runner (no nested shadow, no asset logging).
        const { result } = await tool.run(ctx, { ...args, as_user: o.email });
        return { account: o.email, ...summarize(result) };
      } catch (e) {
        return { account: o.email, hit: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const withHits = otherAccounts.filter((o) => o.hit).map((o) => o.account);
  const note =
    `Mandatory cross-account check: the same read was run in ${others.length} other registered ` +
    `account(s) besides ${targetEmail}. ` +
    (withHits.length
      ? `Hits also found in: ${withHits.join(", ")}. If your target account returned nothing, you may have queried the wrong account.`
      : `No hits in the other account(s).`);

  return { note, targetAccount: targetEmail, otherAccounts };
}

/** True unless GWS_SHADOW_SEARCH is explicitly turned off. */
function shadowEnabled(env: Env): boolean {
  const v = (env as unknown as { GWS_SHADOW_SEARCH?: string }).GWS_SHADOW_SEARCH;
  return (v ?? "").trim().toLowerCase() !== "off";
}

/**
 * Invoke a tool with sanitization + mandatory shadow search. Both `/mcp` dispatch
 * and the code-mode `callTool` RPC route through here so the behaviour is uniform.
 */
export async function runTool(
  tool: ToolDef,
  ctx: ToolCtx,
  rawArgs: unknown,
): Promise<{ result: unknown; asset?: ToolAsset }> {
  const args = sanitizeArgs((rawArgs ?? {}) as Record<string, unknown>);
  const primary = await tool.run(ctx, args);

  if (!SHADOW_TOOLS.has(tool.name) || !shadowEnabled(ctx.env)) return primary;

  try {
    const shadow = await computeShadow(tool, ctx, args);
    if (!shadow) return primary;
    return { result: withShadow(primary.result, shadow), asset: primary.asset };
  } catch {
    return primary; // shadow is best-effort; never fail the primary call over it
  }
}
