/**
 * @file lib/scripts/types.ts
 * @description Shared types for the downloadable-scripts docs suite. A
 * `ScriptSpec` describes one "gotcha" script (e.g. run a Drive folder report):
 * which MCP tool it calls over the REST bridge (`POST /api/tools/<tool>`) and
 * what parameters it takes. Code generators turn a spec + filled-in values into
 * curl / Python / TypeScript / Apps Script snippets — so a new script is just
 * one more entry in the registry, no per-language hand-authoring.
 */

/** One user-supplied parameter (maps to a tool arg / request-body key). */
export interface ScriptParam {
  /** Arg key sent in the request body, e.g. "folderId". */
  name: string;
  /** Human label shown in the form. */
  label: string;
  /** Whether the arg is required (documented + pre-filled with the default). */
  required?: boolean;
  /** Default value pre-filled in the form and snippets. */
  default?: string;
  placeholder?: string;
  /** Short helper text under the field. */
  help?: string;
  /** Coerced to a number in the request body when "number". Default "string". */
  type?: "string" | "number";
}

/** One downloadable script in the suite. */
export interface ScriptSpec {
  /** URL slug: /docs/scripts/<slug>. */
  slug: string;
  title: string;
  /** One-line summary for the card + page header. */
  summary: string;
  /** Category chip (e.g. "Drive", "Docs"). */
  tag: string;
  emoji: string;
  /** MCP tool invoked over the REST bridge (POST /api/tools/<tool>). */
  tool: string;
  params: ScriptParam[];
  /** Optional note about what the tool returns. */
  resultNote?: string;
  /** Default local path to save the response to (curl `-o`, file write in Python/TS). */
  defaultOutput?: string;
}
