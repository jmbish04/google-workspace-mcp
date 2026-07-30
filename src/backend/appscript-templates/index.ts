/**
 * @file appscript-templates/index.ts
 * @description Registry + assembler for container-bound Apps Script templates.
 *
 * `buildTemplate(name, config)` returns the Apps Script `files[]` array to push
 * into a bound project (via `projects.updateContent`). Config-driven templates
 * inject a generated `Config.gs` so one generic template serves every document.
 *
 * Templates:
 *   - `agent-questions` — custom menu + JSON-driven questions sidebar; answers
 *      land in a new Doc tab / Sheet tab / appendix slide based on the host.
 *   - `webapp` — `doGet` HTML web-app shell driven by the injected config.
 *   - `sidebar`, `chat-sidebar` — legacy static scaffolds (kept for back-compat).
 */

import { SCRIPT_SCAFFOLDS } from "@/backend/docs/appscript-scaffolds";

import { buildConfigFile } from "./common/config";
import { HOST_GS } from "./common/host";
import { MENU_GS } from "./common/menu";
import { buildManifest } from "./manifest";
import { QUESTIONS_GS } from "./questions/server";
import { SIDEBAR_HTML } from "./questions/sidebar";
import type { BindConfig, ScriptFile } from "./types";
import { PAGE_HTML } from "./webapp/page";
import { WEBAPP_GS } from "./webapp/server";

export type { BindConfig, ScriptFile } from "./types";

/** Names accepted by {@link buildTemplate}. */
export const TEMPLATE_NAMES = [
  "agent-questions",
  "webapp",
  "sidebar",
  "chat-sidebar",
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Config-driven template builders (each returns a fresh `files[]`). */
const BUILDERS: Record<
  "agent-questions" | "webapp",
  (config: BindConfig) => ScriptFile[]
> = {
  "agent-questions": (config) => [
    buildManifest({ docsAdvancedService: true }),
    buildConfigFile(withQuestionsDefaults_(config)),
    MENU_GS,
    HOST_GS,
    QUESTIONS_GS,
    SIDEBAR_HTML,
  ],
  webapp: (config) => {
    const files = [
      buildManifest({ webapp: true }),
      buildConfigFile(config),
      WEBAPP_GS,
      PAGE_HTML,
    ];
    // Include the menu only when the config defines one.
    if (config.menu?.items?.length) files.splice(2, 0, MENU_GS, HOST_GS);
    return files;
  },
};

/**
 * Assemble the Apps Script `files[]` for a template.
 *
 * @param name - Template name (see {@link TEMPLATE_NAMES})
 * @param config - Per-doc bind config (unused by the legacy static templates)
 * @returns The files to push into a bound Apps Script project
 * @throws If `name` is not a known template
 */
export function buildTemplate(name: string, config: BindConfig): ScriptFile[] {
  if (name === "agent-questions" || name === "webapp")
    return BUILDERS[name](config);
  const legacy = SCRIPT_SCAFFOLDS[name];
  if (legacy) return legacy as ScriptFile[];
  throw new Error(
    `Unknown Apps Script template "${name}". Known: ${TEMPLATE_NAMES.join(", ")}.`
  );
}

/**
 * Ensure the questions template has a menu that opens the sidebar, so a bound
 * doc is usable even when the caller omits `menu`.
 */
function withQuestionsDefaults_(config: BindConfig): BindConfig {
  if (config.menu?.items?.length) return config;
  const title = config.questions?.title ?? "Agent";
  return {
    ...config,
    menu: {
      name: title,
      items: [{ label: "Answer questions", fn: "showQuestions" }],
    },
  };
}
