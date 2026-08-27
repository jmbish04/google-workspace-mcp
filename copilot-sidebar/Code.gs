/**
 * Copilot sidebar for the Google editor. Adds a "Copilot" menu that opens a
 * chat sidebar (Sidebar.html) which talks to the google-workspace-mcp worker's
 * /api/copilot/chat endpoint.
 *
 * The worker URL + auth token are read from Script Properties and injected into
 * the HTML at render time — NEVER hardcode them here. Set once:
 *   File → Project Settings → Script Properties:
 *     WORKER_URL   = https://google-workspace-mcp.hacolby.workers.dev
 *     WORKER_TOKEN = <the worker's WORKER_API_KEY>
 *
 * onOpen uses DocumentApp (Docs). For Sheets/Slides/Forms, swap to
 * SpreadsheetApp / SlidesApp / FormApp (they expose the same getUi()/showSidebar).
 */
function onOpen() {
  DocumentApp.getUi()
    .createMenu('Copilot')
    .addItem('Open Chat', 'showCopilotSidebar')
    .addToUi();
}

function showCopilotSidebar() {
  var props = PropertiesService.getScriptProperties();
  var template = HtmlService.createTemplateFromFile('Sidebar');
  template.workerUrl = (props.getProperty('WORKER_URL') || '').replace(/\/+$/, '');
  template.token = props.getProperty('WORKER_TOKEN') || '';
  var html = template.evaluate().setTitle('AI Copilot').setWidth(360);
  DocumentApp.getUi().showSidebar(html);
}
