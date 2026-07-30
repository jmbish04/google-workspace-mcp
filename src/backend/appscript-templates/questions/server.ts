/**
 * @file appscript-templates/questions/server.ts
 * @description `Questions.gs` — server entry points for the AI follow-up
 * questions sidebar. The agent supplies a question schema in `AGENT_CONFIG.questions`;
 * the sidebar renders it, and submitted answers are routed to the host's output
 * (Doc tab / Sheet tab / appendix slide) via `Host.gs`.
 */

import type { ScriptFile } from "../types";

/** `Questions.gs` — sidebar open + config + submit handlers. */
export const QUESTIONS_GS: ScriptFile = {
  name: "Questions",
  type: "SERVER_JS",
  source: `/**
 * Opens the questions sidebar in the current host editor.
 * Wire this to a menu item (AGENT_CONFIG.menu[].fn = "showQuestions").
 */
function showQuestions() {
  var ui = getUi_();
  if (!ui) throw new Error('No host UI available to show the sidebar.');
  var cfg = getQuestionsConfig();
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle(cfg.title || 'Questions');
  ui.showSidebar(html);
}

/**
 * @returns {!Object} The questions config for the client form
 *   ({ title, intro, outputTitle, fields }).
 */
function getQuestionsConfig() {
  return (getConfig_() || {}).questions || { title: 'Questions', fields: [] };
}

/**
 * Receives submitted answers from the sidebar and writes them into the host.
 *
 * @param {!Object<string, (string|!Array<string>)>} answers Field id -> value.
 * @returns {string} A confirmation message displayed in the sidebar.
 */
function submitAnswers(answers) {
  answers = answers || {};
  var cfg = getQuestionsConfig();
  var rows = (cfg.fields || []).map(function (field) {
    var value = answers[field.id];
    if (Array.isArray(value)) value = value.join(', ');
    return { label: field.label, value: value == null ? '' : String(value) };
  });
  return writeAnswers_(cfg.outputTitle || cfg.title || 'Responses', rows);
}
`,
};
