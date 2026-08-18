/**
 * @file lib/scripts/generators.ts
 * @description Pure code generators: turn a {@link ScriptSpec} + filled-in
 * parameter values into runnable snippets in several languages, all hitting the
 * same REST bridge endpoint (`POST /api/tools/<tool>`). No per-language
 * hand-authoring — add a script to the registry and every language comes free.
 *
 * Auth is referenced, never embedded: curl/Python/TypeScript read a
 * `WORKER_API_KEY` env var; Apps Script reads a Script Property. That keeps real
 * tokens out of copied/downloaded files.
 */
import type { CodeBlockFile } from "@/components/ui/code-block";

import type { ScriptSpec } from "./types";

/** One generated snippet: a language tab holding one or more files. */
export interface GeneratedSnippet {
  id: string;
  label: string;
  /** Primary download filename (first file). */
  filename: string;
  files: CodeBlockFile[];
}

/** Build the request-body object from the spec's params + current values. */
export function buildBody(spec: ScriptSpec, values: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const p of spec.params) {
    const raw = values[p.name] ?? p.default ?? "";
    if (raw === "") continue;
    body[p.name] = p.type === "number" ? Number(raw) : raw;
  }
  return body;
}

/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const APPSSCRIPT_MANIFEST = JSON.stringify(
  {
    timeZone: "America/Los_Angeles",
    exceptionLogging: "STACKDRIVER",
    runtimeVersion: "V8",
    // UrlFetchApp to an external host needs this scope.
    oauthScopes: ["https://www.googleapis.com/auth/script.external_request"],
  },
  null,
  2,
);

/** A safe JS/TS identifier derived from a tool name, e.g. run_DriveFolderTree. */
function fnName(tool: string): string {
  const camel = tool.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `run_${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** Options that affect generation but aren't tool args. */
export interface SnippetOptions {
  /** Save the response `result` to this local path (curl `-o`, file write in Python/TS). */
  outputPath?: string;
}

/**
 * Generate all language snippets for a script.
 *
 * @param baseUrl - origin of this deployment (e.g. https://gws.example.com)
 * @param options - non-arg options (e.g. an output file path)
 */
export function generateSnippets(
  spec: ScriptSpec,
  values: Record<string, string>,
  baseUrl: string,
  options: SnippetOptions = {},
): GeneratedSnippet[] {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tools/${spec.tool}`;
  const body = buildBody(spec, values);
  const json = JSON.stringify(body, null, 2);
  const jsonCompact = JSON.stringify(body);
  const fn = fnName(spec.tool);
  const out = options.outputPath?.trim() || undefined;

  const curlLines = [
    `curl -X POST ${shellSingleQuote(url)}`,
    `  -H "Authorization: Bearer $WORKER_API_KEY"`,
    `  -H "Content-Type: application/json"`,
    `  -d ${shellSingleQuote(jsonCompact)}`,
  ];
  if (out) curlLines.push(`  -o ${shellSingleQuote(out)}`);
  const curl = curlLines.join(" \\\n") + "\n";

  const pythonTail = out
    ? [
        `result = resp.json()["result"]`,
        `out_path = os.path.expanduser(${JSON.stringify(out)})`,
        `with open(out_path, "w") as f:`,
        `    json.dump(result, f, indent=2)`,
        `print(f"Wrote {out_path}")`,
      ]
    : [`result = resp.json()["result"]`, `print(json.dumps(result, indent=2))`];
  const python = [
    `import json`,
    `import os`,
    `import requests`,
    ``,
    `BASE = os.environ.get("WORKER_BASE_URL", ${JSON.stringify(baseUrl)})`,
    `TOKEN = os.environ["WORKER_API_KEY"]`,
    ``,
    `body = json.loads(r"""`,
    json,
    `""")`,
    ``,
    `resp = requests.post(`,
    `    f"{BASE}/api/tools/${spec.tool}",`,
    `    headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},`,
    `    json=body,`,
    `)`,
    `resp.raise_for_status()`,
    ...pythonTail,
    ``,
  ].join("\n");

  const tsImports = out ? [`import { writeFile } from "node:fs/promises";`, `import { homedir } from "node:os";`, ``] : [];
  const tsTail = out
    ? [
        `const { result } = await res.json();`,
        `const outPath = ${JSON.stringify(out)}.replace(/^~/, homedir());`,
        `await writeFile(outPath, JSON.stringify(result, null, 2));`,
        `console.log(\`Wrote \${outPath}\`);`,
      ]
    : [`const { result } = await res.json();`, `console.log(result);`];
  const typescript = [
    ...tsImports,
    `const BASE = process.env.WORKER_BASE_URL ?? ${JSON.stringify(baseUrl)};`,
    `const TOKEN = process.env.WORKER_API_KEY!;`,
    ``,
    `const body = ${json};`,
    ``,
    `const res = await fetch(\`\${BASE}/api/tools/${spec.tool}\`, {`,
    `  method: "POST",`,
    `  headers: {`,
    `    Authorization: \`Bearer \${TOKEN}\`,`,
    `    "Content-Type": "application/json",`,
    `  },`,
    `  body: JSON.stringify(body),`,
    `});`,
    `if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);`,
    ...tsTail,
    ``,
  ].join("\n");

  const gs = [
    `/**`,
    ` * ${spec.title} — calls the Google Workspace MCP REST bridge.`,
    ` * Set the WORKER_API_KEY Script Property: Project Settings → Script Properties.`,
    ` */`,
    `function ${fn}() {`,
    `  const BASE = ${JSON.stringify(baseUrl)};`,
    `  const TOKEN = PropertiesService.getScriptProperties().getProperty('WORKER_API_KEY');`,
    `  const body = ${jsonCompact};`,
    ``,
    `  const res = UrlFetchApp.fetch(BASE + '/api/tools/${spec.tool}', {`,
    `    method: 'post',`,
    `    contentType: 'application/json',`,
    `    headers: { Authorization: 'Bearer ' + TOKEN },`,
    `    payload: JSON.stringify(body),`,
    `    muteHttpExceptions: true,`,
    `  });`,
    `  if (res.getResponseCode() >= 400) {`,
    `    throw new Error('HTTP ' + res.getResponseCode() + ': ' + res.getContentText());`,
    `  }`,
    `  const result = JSON.parse(res.getContentText()).result;`,
    `  Logger.log(result);`,
    `  return result;`,
    `}`,
    ``,
  ].join("\n");

  return [
    { id: "curl", label: "cURL", filename: `${spec.tool}.sh`, files: [{ filename: `${spec.tool}.sh`, language: "bash", code: curl }] },
    { id: "python", label: "Python", filename: `${spec.tool}.py`, files: [{ filename: `${spec.tool}.py`, language: "python", code: python }] },
    { id: "typescript", label: "TypeScript", filename: `${spec.tool}.ts`, files: [{ filename: `${spec.tool}.ts`, language: "typescript", code: typescript }] },
    {
      id: "appsscript",
      label: "Apps Script",
      filename: "Code.gs",
      files: [
        { filename: "Code.gs", language: "javascript", code: gs },
        { filename: "appsscript.json", language: "json", code: APPSSCRIPT_MANIFEST + "\n" },
      ],
    },
  ];
}
