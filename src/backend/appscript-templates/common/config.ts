/**
 * @file appscript-templates/common/config.ts
 * @description Generates `Config.gs` — the one per-doc file in an otherwise
 * generic template. The bind config (menu, questions, output target) is
 * serialized into a global `AGENT_CONFIG` so a single template serves every
 * document without a rebuild; the rest of the template reads it via `getConfig_()`.
 */

import type { BindConfig, ScriptFile } from "../types";

/**
 * Build the generated `Config.gs` file for a bound project.
 *
 * @param config - The per-doc bind config
 * @returns `Config.gs` as a SERVER_JS {@link ScriptFile}
 */
export function buildConfigFile(config: BindConfig): ScriptFile {
  const json = JSON.stringify(config, null, 2);
  return {
    name: "Config",
    type: "SERVER_JS",
    source: `/**
 * Generated per-doc configuration. Do not edit by hand — regenerate by
 * re-binding the script with a new config.
 */
var AGENT_CONFIG = ${json};

/**
 * @returns {!Object} The bound agent config injected at deploy time.
 */
function getConfig_() {
  return AGENT_CONFIG;
}
`,
  };
}
