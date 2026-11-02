/**
 * @fileoverview Small pieces every MCP tool module shares: the optional
 * `as_user` schema field and the {@link acct} account resolver.
 *
 * They live here, not in `tools.ts`, so a tool module that `tools.ts` spreads
 * into `TOOLS` (for example `docs-engine-tools.ts`) can import them without a
 * circular VALUE import: `tools.ts` evaluates its `TOOLS` array at module load,
 * so a module it imports must not read a value back out of `tools.ts`.
 *
 * @example
 * ```typescript
 * import { acct, asUser } from "@/backend/mcp/tool-common";
 * const schema = z.object({ documentId: z.string(), ...asUser });
 * const account = acct(sub, args);
 * ```
 */
import { z } from "zod";

/** Optional impersonation field mixed into every tool schema. */
export const asUser = {
  as_user: z
    .string()
    .email()
    .optional()
    .describe(
      "Optional email to act as. Uses a stored per-user OAuth refresh token for that account when one exists (works for consumer/standalone mailboxes), otherwise falls back to Workspace domain-wide delegation. Omit to use the signed-in account (default).",
    ),
};

/**
 * Resolve the account ref for a call: the `as_user` email, else the signed-in sub.
 *
 * @param sub - the caller's signed-in account ref
 * @param a - the tool args (only `as_user` is read)
 * @returns the lower-cased `as_user` email, or `sub` when none was given
 * @example
 * acct("jmbish04@gmail.com", { as_user: "Justin@126colby.com" }) // → "justin@126colby.com"
 */
export function acct(sub: string, a: { as_user?: string }): string {
  return a.as_user ? a.as_user.trim().toLowerCase() : sub;
}
