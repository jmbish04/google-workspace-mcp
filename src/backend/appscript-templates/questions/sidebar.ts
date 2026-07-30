/**
 * @file appscript-templates/questions/sidebar.ts
 * @description `Sidebar.html` — the questions form. It pulls the question
 * schema from the server (`getQuestionsConfig`) and renders controls per field
 * type (text / textarea / single-select radios / multi-select checkboxes), then
 * submits the collected answers back to `submitAnswers`.
 *
 * Client JS uses string concatenation (no template literals) so the source
 * survives being embedded in this module's own template literal untouched.
 */

import type { ScriptFile } from "../types";

/** `Sidebar.html` — JSON-driven questions form. */
export const SIDEBAR_HTML: ScriptFile = {
  name: "Sidebar",
  type: "HTML",
  source: `<!DOCTYPE html>
<html>
  <head>
    <base target="_top" />
    <style>
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 12px; color: #202124; }
      h3 { margin: 0 0 4px; font-size: 15px; }
      .intro { color: #5f6368; font-size: 13px; margin: 0 0 12px; }
      .field { margin-bottom: 14px; }
      .field > label.q { display: block; font-weight: bold; font-size: 13px; margin-bottom: 4px; }
      input[type="text"], textarea, select { width: 100%; box-sizing: border-box; padding: 6px; font-size: 13px; }
      .opt { display: block; font-size: 13px; margin: 2px 0; font-weight: normal; }
      button { background: #1a73e8; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
      button:disabled { background: #9aa0a6; cursor: default; }
      #status { font-size: 13px; margin-top: 10px; min-height: 16px; }
      #status.ok { color: #188038; }
      #status.err { color: #d93025; }
    </style>
  </head>
  <body>
    <h3 id="title">Questions</h3>
    <p class="intro" id="intro"></p>
    <form id="form"></form>
    <button id="submit" type="button" onclick="submit_()">Submit</button>
    <div id="status"></div>

    <script>
      var FIELDS = [];

      // Load the question schema and build the form.
      google.script.run.withSuccessHandler(render_).withFailureHandler(function (e) {
        setStatus_('Failed to load questions: ' + e.message, 'err');
      }).getQuestionsConfig();

      function render_(cfg) {
        cfg = cfg || {};
        FIELDS = cfg.fields || [];
        document.getElementById('title').textContent = cfg.title || 'Questions';
        var intro = document.getElementById('intro');
        if (cfg.intro) { intro.textContent = cfg.intro; } else { intro.style.display = 'none'; }
        var form = document.getElementById('form');
        form.innerHTML = '';
        FIELDS.forEach(function (field) { form.appendChild(buildField_(field)); });
      }

      function buildField_(field) {
        var wrap = document.createElement('div');
        wrap.className = 'field';
        var label = document.createElement('label');
        label.className = 'q';
        label.textContent = field.label || field.id;
        wrap.appendChild(label);

        if (field.type === 'textarea') {
          wrap.appendChild(el_('textarea', { id: ctl_(field.id), rows: '3' }));
        } else if (field.type === 'single') {
          (field.options || []).forEach(function (opt) {
            wrap.appendChild(choice_('radio', field.id, opt));
          });
        } else if (field.type === 'multi') {
          (field.options || []).forEach(function (opt) {
            wrap.appendChild(choice_('checkbox', field.id, opt));
          });
        } else {
          wrap.appendChild(el_('input', { id: ctl_(field.id), type: 'text' }));
        }
        return wrap;
      }

      function choice_(type, id, opt) {
        var label = document.createElement('label');
        label.className = 'opt';
        var input = el_('input', { type: type, name: id, value: opt });
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + opt));
        return label;
      }

      function el_(tag, attrs) {
        var node = document.createElement(tag);
        Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        return node;
      }

      // DOM-safe id for a text/textarea control.
      function ctl_(id) { return 'ctl_' + id; }

      function collect_() {
        var answers = {};
        FIELDS.forEach(function (field) {
          if (field.type === 'single') {
            var picked = document.querySelector('input[name="' + field.id + '"]:checked');
            answers[field.id] = picked ? picked.value : '';
          } else if (field.type === 'multi') {
            var boxes = document.querySelectorAll('input[name="' + field.id + '"]:checked');
            answers[field.id] = Array.prototype.map.call(boxes, function (b) { return b.value; });
          } else {
            var ctl = document.getElementById(ctl_(field.id));
            answers[field.id] = ctl ? ctl.value : '';
          }
        });
        return answers;
      }

      function submit_() {
        var btn = document.getElementById('submit');
        btn.disabled = true;
        setStatus_('Saving...', '');
        google.script.run
          .withSuccessHandler(function (msg) { setStatus_(msg || 'Saved.', 'ok'); btn.disabled = false; })
          .withFailureHandler(function (e) { setStatus_('Error: ' + e.message, 'err'); btn.disabled = false; })
          .submitAnswers(collect_());
      }

      function setStatus_(text, cls) {
        var s = document.getElementById('status');
        s.textContent = text;
        s.className = cls;
      }
    </script>
  </body>
</html>`,
};
