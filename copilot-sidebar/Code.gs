/**
 * Copilot sidebar for the Google editor — thin iframe wrapper.
 *
 * The sidebar embeds the worker's copilot PAGE in an iframe, passing (a) a
 * short-lived token minted server-side (so WORKER_API_KEY never rides in the
 * URL) and (b) the ACTIVE file's Drive id + host type, so the worker page is
 * tailored to the document the sidebar is attached to.
 *
 * Script Properties (Project Settings → Script Properties):
 *   WORKER_URL   = https://google-workspace-mcp.hacolby.workers.dev
 *   WORKER_TOKEN = the worker's WORKER_API_KEY
 *
 * onOpen uses DocumentApp (Docs). For Sheets/Slides swap to SpreadsheetApp /
 * SlidesApp — same getUi()/showSidebar + getActive().getId().
 */
function onOpen() {
  DocumentApp.getUi().createMenu('Copilot').addItem('Open Chat', 'showCopilotSidebar').addToUi();
}

/** Active file id + host type for the current editor. */
function activeFile_() {
  try { var d = DocumentApp.getActiveDocument(); if (d) return { id: d.getId(), hostType: 'doc' }; } catch (e) {}
  try { var s = SpreadsheetApp.getActiveSpreadsheet(); if (s) return { id: s.getId(), hostType: 'sheet' }; } catch (e) {}
  try { var p = SlidesApp.getActivePresentation(); if (p) return { id: p.getId(), hostType: 'slides' }; } catch (e) {}
  return { id: '', hostType: '' };
}

/** Mint a short-lived copilot token from the worker (server-side; key stays in GAS). */
function mintToken_(workerUrl, workerToken, file) {
  var res = UrlFetchApp.fetch(workerUrl + '/api/copilot/token', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + workerToken },
    payload: JSON.stringify({ account: 'workspace', fileId: file.id, hostType: file.hostType }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('token mint failed: ' + res.getContentText());
  return JSON.parse(res.getContentText()).token;
}

function showCopilotSidebar() {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = (props.getProperty('WORKER_URL') || '').replace(/\/+$/, '');
  var workerToken = props.getProperty('WORKER_TOKEN') || '';
  var file = activeFile_();
  var token = mintToken_(workerUrl, workerToken, file);

  var src = workerUrl + '/api/copilot/page?token=' + encodeURIComponent(token) +
            '&fileId=' + encodeURIComponent(file.id) +
            '&hostType=' + encodeURIComponent(file.hostType);

  var html = HtmlService.createHtmlOutput(
    '<style>html,body{height:100%;margin:0}iframe{border:0;width:100%;height:100vh;display:block}</style>' +
    '<iframe src="' + src + '" allow="clipboard-write"></iframe>'
  ).setTitle('AI Copilot').setWidth(360);

  DocumentApp.getUi().showSidebar(html);
}
