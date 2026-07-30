/**
 * @file appscript-templates/webapp/page.ts
 * @description `Page.html` — the web-app page. Reads the injected config via the
 * server's `configJson_()` printing scriptlet and renders its title/intro. A
 * deliberately small starting point for agents to extend.
 */

import type { ScriptFile } from "../types";

/** `Page.html` — web-app page shell driven by the injected config. */
export const PAGE_HTML: ScriptFile = {
  name: "Page",
  type: "HTML",
  source: `<!DOCTYPE html>
<html>
  <head>
    <base target="_top" />
    <style>
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; color: #202124; max-width: 720px; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p.intro { color: #5f6368; margin: 0 0 16px; }
    </style>
  </head>
  <body>
    <h1 id="title">App</h1>
    <p class="intro" id="intro"></p>

    <script>
      // Injected as a raw JS object literal (valid JSON is valid JS).
      var CONFIG = <?!= configJson_() ?>;
      document.getElementById('title').textContent =
        (CONFIG.webapp && CONFIG.webapp.title) || CONFIG.title || 'App';
      var intro = document.getElementById('intro');
      if (CONFIG.webapp && CONFIG.webapp.intro) {
        intro.textContent = CONFIG.webapp.intro;
      } else {
        intro.style.display = 'none';
      }
    </script>
  </body>
</html>`,
};
