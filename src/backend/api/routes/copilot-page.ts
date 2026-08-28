/**
 * @file api/routes/copilot-page.ts
 * @description The copilot iframe page (served at GET /api/copilot/page). A
 * self-contained HTML chat (no external deps) that reads `token`, `fileId`, and
 * `hostType` from the query and POSTs to /api/copilot/chat (same-origin) with the
 * token as the bearer. The active-file context makes the copilot aware of the
 * document the GAS sidebar is attached to.
 *
 * ponytail: intentionally vanilla + self-contained so it works inside the GAS
 * HtmlService iframe with zero build/CDN. Upgrade path: swap this for the built
 * shadcn/React copilot page once the frontend build serves it.
 */
export function copilotPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copilot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html,body { height:100%; margin:0; background:#0a0a0b; color:#e7e7ea; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  #app { display:flex; flex-direction:column; height:100vh; padding:12px; }
  #ctx { font-size:11px; color:#7a7a85; padding-bottom:8px; }
  #log { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding-right:4px; }
  .b { max-width:92%; padding:8px 12px; border-radius:14px; white-space:pre-wrap; word-break:break-word; }
  .me { align-self:flex-end; background:#2563eb; color:#fff; }
  .ai { align-self:flex-start; background:#161618; border:1px solid #26262a; }
  .err { align-self:flex-start; color:#fca5a5; border:1px solid #7f1d1d; background:#2a0f0f; border-radius:12px; padding:8px 12px; font-size:12px; }
  .think { align-self:flex-start; color:#9a9aa3; font-size:12px; animation:sh 1.4s ease-in-out infinite; }
  @keyframes sh { 0%,100%{opacity:.4} 50%{opacity:1} }
  #hint { color:#5a5a63; font-size:12px; text-align:center; margin-top:24px; }
  #bar { display:flex; gap:8px; padding-top:10px; }
  #in { flex:1; background:#161618; border:1px solid #26262a; border-radius:12px; padding:8px 12px; color:inherit; font:inherit; }
  #in:focus { outline:none; border-color:#2563eb; }
  #send { background:#2563eb; color:#fff; border:0; border-radius:12px; padding:8px 16px; font:inherit; font-weight:600; cursor:pointer; }
  #send:disabled, #in:disabled { opacity:.5; }
</style></head>
<body><div id="app">
  <div id="ctx"></div>
  <div id="log"><div id="hint">Ask me to search mail, edit this file, build a sheet, schedule an event…</div></div>
  <div id="bar"><input id="in" placeholder="Ask copilot…" autocomplete="off"><button id="send">Send</button></div>
</div>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  var token = q.get('token') || '';
  var fileId = q.get('fileId') || '';
  var hostType = q.get('hostType') || '';
  var account = q.get('account') || '';
  var log = document.getElementById('log'), input = document.getElementById('in'), send = document.getElementById('send'), ctxEl = document.getElementById('ctx');
  ctxEl.textContent = 'Copilot' + (hostType ? ' · attached to this ' + hostType : '') + (fileId ? ' (' + fileId.slice(0,8) + '…)' : '');
  var messages = [];
  function bubble(cls, text){ var d=document.createElement('div'); d.className=cls; d.textContent=text; var h=document.getElementById('hint'); if(h)h.remove(); log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }
  var busy=false;
  function setBusy(b){ busy=b; input.disabled=b; send.disabled=b; }
  async function submit(){
    var text=input.value.trim(); if(!text||busy) return;
    messages.push({role:'user',content:text}); bubble('b me', text); input.value=''; setBusy(true);
    var t=bubble('think','Thinking…');
    try{
      var res=await fetch('/api/copilot/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
        body:JSON.stringify({messages:messages, fileId:fileId||undefined, hostType:hostType||undefined, account:account||undefined})});
      var data=await res.json(); t.remove();
      if(!res.ok) throw new Error(data&&data.error?data.error:('HTTP '+res.status));
      var reply=data.reply||'(no reply)'; messages.push({role:'assistant',content:reply}); bubble('b ai', reply);
    }catch(e){ t.remove(); bubble('err', String(e&&e.message?e.message:e)); }
    finally{ setBusy(false); input.focus(); }
  }
  send.onclick=submit; input.addEventListener('keydown',function(e){ if(e.key==='Enter') submit(); });
  input.focus();
})();
</script></body></html>`;
}
