/**
 * @file appscript-templates/common/host.ts
 * @description `Host.gs` — host detection + answer-output routing shared by
 * every container-bound template. A bound script has exactly one live host, so
 * output routes by which of Doc/Sheet/Slides is active:
 *   - Doc   -> a new document tab (Docs advanced service `AddDocumentTabRequest`)
 *   - Sheet -> a new sheet tab
 *   - Slide -> an appended appendix slide
 */

import type { ScriptFile } from "../types";

/** `Host.gs` — host detection + output writers. */
export const HOST_GS: ScriptFile = {
  name: "Host",
  type: "SERVER_JS",
  source: `/**
 * Host detection and answer-output routing.
 *
 * A container-bound script only ever has one live host, so exactly one of the
 * active-container accessors below returns a value.
 */

/**
 * @returns {string} The host kind: 'doc', 'sheet', 'slide', or 'unknown'.
 */
function hostType_() {
  try { if (DocumentApp.getActiveDocument()) return 'doc'; } catch (e) {}
  try { if (SpreadsheetApp.getActiveSpreadsheet()) return 'sheet'; } catch (e) {}
  try { if (SlidesApp.getActivePresentation()) return 'slide'; } catch (e) {}
  return 'unknown';
}

/**
 * @returns {?GoogleAppsScript.Base.Ui} The host editor UI, or null if headless.
 */
function getUi_() {
  switch (hostType_()) {
    case 'doc': return DocumentApp.getUi();
    case 'sheet': return SpreadsheetApp.getUi();
    case 'slide': return SlidesApp.getUi();
    default: return null;
  }
}

/**
 * Writes answer rows into the host container, routing by host type.
 *
 * @param {string} title Section / tab / slide title.
 * @param {!Array<{label: string, value: string}>} rows Answer rows.
 * @returns {string} A human-readable description of where the answers landed.
 */
function writeAnswers_(title, rows) {
  switch (hostType_()) {
    case 'doc': return writeDocTab_(title, rows);
    case 'sheet': return writeSheetTab_(title, rows);
    case 'slide': return writeSlideAppendix_(title, rows);
    default: throw new Error('Unsupported host: answers can only be written to a Doc, Sheet, or Slides file.');
  }
}

/**
 * Adds a new document tab and fills it with the answers.
 * Uses the Docs advanced service (declared in the manifest).
 *
 * @param {string} title Tab title.
 * @param {!Array<{label: string, value: string}>} rows Answer rows.
 * @returns {string} Confirmation string.
 */
function writeDocTab_(title, rows) {
  var docId = DocumentApp.getActiveDocument().getId();
  // 1. Add the tab at the end of the tab order.
  Docs.Documents.batchUpdate(
    { requests: [{ addDocumentTab: { tabProperties: { title: title } } }] },
    docId
  );
  // 2. Re-read the document to find the tab we just added (last, depth-first).
  var doc = Docs.Documents.get(docId, { includeTabsContent: true });
  var tabs = flattenTabs_(doc.tabs || []);
  var newTab = tabs[tabs.length - 1];
  var tabId = newTab.tabProperties.tabId;
  // 3. Insert the answer text at the start of the new tab's body.
  Docs.Documents.batchUpdate(
    { requests: [{ insertText: { text: answersToText_(title, rows), location: { tabId: tabId, index: 1 } } }] },
    docId
  );
  return 'Added tab "' + title + '" to the document.';
}

/**
 * Flattens a Docs tab tree (tabs may contain child tabs) depth-first.
 *
 * @param {!Array<!Object>} tabs Tab nodes from the Docs API.
 * @returns {!Array<!Object>} All tabs in document order.
 */
function flattenTabs_(tabs) {
  var out = [];
  tabs.forEach(function (tab) {
    out.push(tab);
    if (tab.childTabs) out = out.concat(flattenTabs_(tab.childTabs));
  });
  return out;
}

/**
 * Inserts a new sheet and writes the answers as Question/Answer rows.
 *
 * @param {string} title Desired sheet tab name.
 * @param {!Array<{label: string, value: string}>} rows Answer rows.
 * @returns {string} Confirmation string.
 */
function writeSheetTab_(title, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = uniqueSheetName_(ss, title || 'Responses');
  var sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, 2).setValues([['Question', 'Answer']]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows.map(function (r) {
      return [r.label, r.value];
    }));
  }
  return 'Added sheet "' + name + '" to the spreadsheet.';
}

/**
 * @param {!GoogleAppsScript.Spreadsheet.Spreadsheet} ss Target spreadsheet.
 * @param {string} base Desired sheet name.
 * @returns {string} A sheet name not already in use.
 */
function uniqueSheetName_(ss, base) {
  var name = base;
  var i = 2;
  while (ss.getSheetByName(name)) { name = base + ' ' + i++; }
  return name;
}

/**
 * Appends a slide containing the answers.
 *
 * @param {string} title Slide title.
 * @param {!Array<{label: string, value: string}>} rows Answer rows.
 * @returns {string} Confirmation string.
 */
function writeSlideAppendix_(title, rows) {
  var pres = SlidesApp.getActivePresentation();
  var slide = pres.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
  var titleShape = slide.getPlaceholder(SlidesApp.PlaceholderType.TITLE) ||
    slide.getPlaceholder(SlidesApp.PlaceholderType.CENTERED_TITLE);
  if (titleShape) titleShape.asShape().getText().setText(title);
  var body = slide.getPlaceholder(SlidesApp.PlaceholderType.BODY);
  if (body) body.asShape().getText().setText(answersToText_('', rows).trim());
  return 'Appended a slide to the presentation.';
}

/**
 * Renders a title + answer rows as plain text.
 *
 * @param {string} title Leading title line (omitted when empty).
 * @param {!Array<{label: string, value: string}>} rows Answer rows.
 * @returns {string} Formatted text block.
 */
function answersToText_(title, rows) {
  var lines = [];
  if (title) { lines.push(title, ''); }
  rows.forEach(function (r) { lines.push(r.label + ': ' + r.value); });
  return lines.join('\\n') + '\\n';
}
`,
};
