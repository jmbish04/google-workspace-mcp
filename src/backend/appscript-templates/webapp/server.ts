/**
 * @file appscript-templates/webapp/server.ts
 * @description `WebApp.gs` — a minimal HTML web-app entry point. `doGet`
 * renders `Page.html` as a template, passing `AGENT_CONFIG` so the page content
 * is driven by the injected JSON. Deploy the project as a web app to get a URL.
 */

import type { ScriptFile } from "../types";

/** `WebApp.gs` — `doGet` HTML web-app entry point. */
export const WEBAPP_GS: ScriptFile = {
  name: "WebApp",
  type: "SERVER_JS",
  source: `/**
 * Serves the web-app page. Deploy the project as a web app to obtain a URL.
 *
 * @param {!GoogleAppsScript.Events.DoGet} e The request event.
 * @returns {!GoogleAppsScript.HTML.HtmlOutput} The rendered page.
 */
function doGet(e) {
  var cfg = getConfig_() || {};
  var template = HtmlService.createTemplateFromFile('Page');
  template.config = cfg;
  var title = (cfg.webapp && cfg.webapp.title) || cfg.title || 'App';
  return template.evaluate().setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * @returns {string} AGENT_CONFIG serialized for embedding in the page.
 */
function configJson_() {
  return JSON.stringify(getConfig_() || {});
}
`,
};
