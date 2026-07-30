/**
 * @file appscript-templates/common/menu.ts
 * @description `Menu.gs` — builds the host editor's custom menu on open from
 * `AGENT_CONFIG.menu`. Each item wires a label to a global function name, so
 * agents point menu entries at whatever functions the template exposes
 * (e.g. `showQuestions`).
 */

import type { ScriptFile } from "../types";

/** `Menu.gs` — config-driven custom menu. */
export const MENU_GS: ScriptFile = {
  name: "Menu",
  type: "SERVER_JS",
  source: `/**
 * Adds the custom menu when the container is opened.
 *
 * Reads AGENT_CONFIG.menu = { name: string, items: [{ label, fn }] } and wires
 * each item to a global function by name. No-op when no menu is configured.
 */
function onOpen() {
  var cfg = getConfig_();
  var menuCfg = cfg && cfg.menu;
  if (!menuCfg || !menuCfg.items || !menuCfg.items.length) return;
  var ui = getUi_();
  if (!ui) return;
  var menu = ui.createMenu(menuCfg.name || 'Agent');
  menuCfg.items.forEach(function (item) {
    menu.addItem(item.label, item.fn);
  });
  menu.addToUi();
}
`,
};
