#!/usr/bin/env node
// colby-ecosystem: managed script — edit it in jmbish04/colby-ecosystem/templates/scripts/,
// never here. `pull-agents` overwrites this file.
//
// scripts/ai-guard.mjs — every AI call goes through core-guardian. This proves it by
// scanning, instead of by somebody noticing in review.
//
// WHY THIS EXISTS, measured 2026-11-02 on the live account:
//
//   The AI router saw 0.0% of the paid account's Workers AI neurons for the whole
//   2026-10-19 cycle — 40,547 neurons, all of them around the governor. So the monthly
//   spend cap cannot see them, the circuit breakers cannot stop them, and Cloudflare's
//   own analytics break neurons down by MODEL, not by Worker, so nobody can even say
//   which project spent them. The cause was countable: 94 of 272 wrangler configs
//   declared a top-level `ai` binding, and 47 repos called `env.AI.run` directly.
//
// RULES
//
//   ai-binding       a wrangler config declaring a top-level `ai` binding. The sample
//                    config in ~/.colby-ecosystem/workers/wrangler.jsonc ships without
//                    one on purpose. core-guardian itself is the exception and declares
//                    it in .ai-guard.json.
//   direct-ai-call   env.AI.run / .models / .toMarkdown / .autorag, or a bare AI.run().
//                    This is the neuron path, and it is unmetered.
//   provider-sdk     importing an OpenAI / Anthropic / Google / Mistral / Cohere SDK.
//                    Same bypass, different door, and it spends real provider money.
//   provider-fetch   fetching a provider base URL directly.
//   allow-reason     an ai-guard-allow with no reason, or naming a rule that
//                    does not exist.
//
// WHAT TO DO INSTEAD — the contract is guardian's own, not this script's invention:
//
//   RPC, worker to worker, no credential (the service binding IS the trust boundary):
//     "services": [{ "binding": "GUARDIAN", "service": "core-guardian",
//                    "entrypoint": "GuardianRpc" }]
//     const r = await env.GUARDIAN.run({ project: "my-worker", importance: "medium",
//                                        input: { messages: [...] } });
//
//   HTTP, for OpenAI-SDK-shaped callers: bind GUARDIAN_HTTP and point baseURL at
//     https://core-guardian/v1 through env.GUARDIAN_HTTP.fetch.
//
//   Outside a Worker: runAI() from ~/.colby-ecosystem/workers/utils/ai.ts.
//
//   Live contract: `guardian_integration_instructions` on the core-guardian MCP, or
//   https://core-guardian.hacolby.workers.dev/openapi.json
//
// THE RATCHET — this is the part that makes it adoptable
//
// 47 repos violate this today. A guard that fails all of them on arrival is a guard
// somebody disables, so the baseline in .ai-guard.json records what a repo already has:
//
//   { "baseline": { "src/backend/ai.ts": 3 }, "allowAiBinding": false }
//
// A new violating file fails. A higher count in a known file fails. A LOWER count passes
// and says so, which is the burn-down. `--update-baseline` re-records, and refuses to
// raise a count without --force, because a baseline that can go up is not a ratchet.
//
// ponytail: counts per file, not line numbers. Line numbers churn on every edit and the
// baseline would conflict constantly; a count still catches the thing that matters, which
// is a call site being added.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const CONFIG = ".ai-guard.json";
const SCAN_DEFAULT = ["src", "web", "worker", "functions", "scripts"];
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const WRANGLER = new Set(["wrangler.jsonc", "wrangler.json", "wrangler.toml"]);
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".git", ".wrangler", "coverage", ".astro", "out", ".venv", "__pycache__"]);

export const RULES = {
  "ai-binding":
    "wrangler declares a top-level `ai` binding — a direct, unmetered line to Workers AI. Bind core-guardian instead (services → GuardianRpc)",
  "direct-ai-call":
    "direct Workers AI call — the spend cap and circuit breakers cannot see it. Route it through core-guardian (env.GUARDIAN.run or runAI)",
  "provider-sdk":
    "provider SDK imported directly — unmetered provider spend. Point an OpenAI-shaped client at core-guardian's /v1 through GUARDIAN_HTTP",
  "provider-fetch":
    "provider base URL fetched directly — same bypass as the SDK, same fix",
  "allow-reason":
    "ai-guard-allow needs a known rule id and a reason: `ai-guard-allow <rule-id>: <why>`",
};

const ALLOW_RE = /ai-guard-allow\s+([\w-]+)(?:\s*:\s*(\S.*?))?\s*(?:\*\/|-->|\}|$)/;

const CALL_RE = /\benv\s*\.\s*AI\s*\.\s*(?:run|models|toMarkdown|autorag)\s*\(|(?<![.\w])AI\s*\.\s*run\s*\(/;
const SDK_RE = /\b(?:import|require)\b[^\n]*?["'](?:openai|@anthropic-ai\/[\w-]+|@google\/gen(?:erative-)?ai|@google\/genai|@mistralai\/[\w-]+|cohere-ai|anthropic|google-generativeai)["']|^\s*(?:import|from)\s+(?:openai|anthropic|google\.generativeai|mistralai|cohere)\b/m;
const FETCH_RE = /https?:\/\/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(?:ai|com)|api\.x\.ai|api\.groq\.com)/;

/** wrangler.jsonc is JSON with comments and trailing commas; strip both. */
export function parseJsonc(text) {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
    m.startsWith('"') ? m : " ",
  );
  return JSON.parse(bare.replace(/,(\s*[}\]])/g, "$1"));
}

/** True when the wrangler config declares a top-level `ai` binding. */
export function declaresAiBinding(filename, text) {
  if (filename.endsWith(".toml")) {
    // [ai] table, or ai = { binding = "AI" }, at the top level.
    const bare = text.replace(/#[^\n]*/g, "");
    return /^\s*\[ai\]/m.test(bare) || /^\s*ai\s*=\s*\{/m.test(bare);
  }
  try {
    const cfg = parseJsonc(text);
    return !!cfg && typeof cfg.ai === "object" && cfg.ai !== null;
  } catch {
    // An unparseable config is not a pass and not a violation — it is a fact the
    // caller has to see, so say so rather than deciding what it meant.
    return "unparseable";
  }
}

/** Which rules a single line trips. */
export function rulesForLine(line) {
  const hit = [];
  if (CALL_RE.test(line)) hit.push("direct-ai-call");
  if (SDK_RE.test(line)) hit.push("provider-sdk");
  if (FETCH_RE.test(line)) hit.push("provider-fetch");
  return hit;
}

function allowedAt(lines, index, rule) {
  for (const n of [index, index - 1]) {
    const m = lines[n]?.match(ALLOW_RE);
    if (m && m[1] === rule && m[2]) return true;
  }
  return false;
}

function walk(dir, out, root, depth = 0) {
  if (depth > 12) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walk(full, out, root, depth + 1);
    } else if (CODE_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

/** Scan a repo. Returns violations plus the stats that say what was covered. */
export function scan(root = ".") {
  const cfgPath = join(root, CONFIG);
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const baseline = cfg.baseline ?? {};
  const include = Array.isArray(cfg.include) && cfg.include.length ? cfg.include : SCAN_DEFAULT;

  const violations = [];
  const counts = {};
  const unparseable = [];
  let scanned = 0;

  const add = (file, line, rule) => {
    violations.push({ file, line, rule, message: RULES[rule] });
    counts[file] = (counts[file] ?? 0) + 1;
  };

  // Wrangler configs sit at the repo root, outside every scan root.
  for (const name of WRANGLER) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    scanned++;
    const text = readFileSync(p, "utf8");
    const verdict = declaresAiBinding(name, text);
    if (verdict === "unparseable") {
      unparseable.push(name);
    } else if (verdict && !cfg.allowAiBinding) {
      const idx = text.split("\n").findIndex((l) => /(^|\s)"?ai"?\s*[:=]/.test(l));
      add(name, idx < 0 ? 1 : idx + 1, "ai-binding");
    }
  }

  const missing = [];
  for (const dir of include) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      if (Array.isArray(cfg.include)) missing.push(dir);
      continue;
    }
    for (const rel of walk(abs, [], root)) {
      scanned++;
      const lines = readFileSync(join(root, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const rule of rulesForLine(line)) {
          if (!allowedAt(lines, i, rule)) add(rel, i + 1, rule);
        }
        const m = line.match(ALLOW_RE);
        if (m && (!m[2] || !RULES[m[1]] || m[1] === "allow-reason")) add(rel, i + 1, "allow-reason");
      });
    }
  }

  // The ratchet: compare per-file counts with what the repo already admitted to.
  const newFiles = Object.keys(counts).filter((f) => !(f in baseline));
  const grew = Object.keys(counts).filter((f) => f in baseline && counts[f] > baseline[f]);
  const shrank = Object.keys(baseline).filter((f) => (counts[f] ?? 0) < baseline[f]);

  return { violations, counts, baseline, newFiles, grew, shrank, scanned, missing, unparseable, hasConfig: existsSync(cfgPath) };
}

function updateBaseline(root, counts, baseline, force) {
  const raised = Object.keys(counts).filter((f) => f in baseline && counts[f] > baseline[f]);
  if (raised.length && !force) {
    console.error(
      `ai-guard: refusing to raise the baseline for ${raised.join(", ")} — a baseline that ` +
        `can go up is not a ratchet. Remove the new call sites, or pass --force and say why ` +
        `in the commit.`,
    );
    return 2;
  }
  const cfgPath = join(root, CONFIG);
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  cfg.baseline = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.error(`ai-guard: baseline written to ${CONFIG} — ${total} violation(s) in ${Object.keys(counts).length} file(s)`);
  return 0;
}

// ------------------------------------------------------------------ self-check
// Every rule gets a planted violation and has to go red, and the clean tree has to go
// green. A check nobody has watched fail is not a check.
function selfCheck() {
  const root = mkdtempSync(join(tmpdir(), "ai-guard-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const write = (p, s) => writeFileSync(join(root, p), s);

  const cases = [
    ["a clean tree passes", { "src/a.ts": "export const x = 1;\n" }, []],
    ["an ai binding is caught", { "wrangler.jsonc": '{\n "name": "w",\n "ai": { "binding": "AI" },\n}\n', "src/a.ts": "" }, ["ai-binding"]],
    ["a toml ai table is caught", { "wrangler.toml": 'name = "w"\n[ai]\nbinding = "AI"\n', "src/a.ts": "" }, ["ai-binding"]],
    ["env.AI.run is caught", { "src/a.ts": "await env.AI.run('@cf/x', {});\n" }, ["direct-ai-call"]],
    ["a spaced env . AI . run is caught", { "src/a.ts": "await env . AI . run('@cf/x');\n" }, ["direct-ai-call"]],
    ["env.AI.toMarkdown is caught", { "src/a.ts": "await env.AI.toMarkdown([]);\n" }, ["direct-ai-call"]],
    ["an openai import is caught", { "src/a.ts": "import OpenAI from 'openai';\n" }, ["provider-sdk"]],
    ["an anthropic import is caught", { "src/a.ts": "import x from '@anthropic-ai/sdk';\n" }, ["provider-sdk"]],
    ["a python provider import is caught", { "src/a.py": "import openai\n" }, ["provider-sdk"]],
    ["a provider fetch is caught", { "src/a.ts": "await fetch('https://api.openai.com/v1/chat');\n" }, ["provider-fetch"]],
    ["an allow with a reason suppresses", { "src/a.ts": "// ai-guard-allow direct-ai-call: guardian itself\nawait env.AI.run('@cf/x');\n" }, []],
    ["an allow with no reason is itself a violation", { "src/a.ts": "// ai-guard-allow direct-ai-call\nawait env.AI.run('@cf/x');\n" }, ["direct-ai-call", "allow-reason"]],
    ["an allow naming an unknown rule is a violation", { "src/a.ts": "// ai-guard-allow not-a-rule: because\n" }, ["allow-reason"]],
    ["allowAiBinding exempts the binding", { ".ai-guard.json": '{"allowAiBinding":true}', "wrangler.jsonc": '{ "ai": { "binding": "AI" } }', "src/a.ts": "" }, []],
    ["an unparseable wrangler is reported, not passed", { "wrangler.jsonc": "{ this is not json", "src/a.ts": "" }, []],
  ];

  for (const [what, files, expected] of cases) {
    for (const p of ["wrangler.jsonc", "wrangler.json", "wrangler.toml", ".ai-guard.json", "src/a.ts", "src/a.py"]) {
      try { rmSync(join(root, p)); } catch {}
    }
    for (const [p, s] of Object.entries(files)) write(p, s);
    const r = scan(root);
    const got = r.violations.map((v) => v.rule).sort();
    const want = [...expected].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`self-check failed: ${what} — expected [${want}], got [${got}]`);
    }
    if (what.startsWith("an unparseable") && r.unparseable.length !== 1) {
      throw new Error("self-check failed: an unparseable wrangler must be reported");
    }
  }

  // The ratchet itself: baseline holds, growth fails, shrinkage is visible.
  for (const p of ["wrangler.jsonc", ".ai-guard.json"]) { try { rmSync(join(root, p)); } catch {} }
  write("src/a.ts", "await env.AI.run('a');\nawait env.AI.run('b');\n");
  write(".ai-guard.json", JSON.stringify({ baseline: { "src/a.ts": 2 } }));
  let r = scan(root);
  if (r.newFiles.length || r.grew.length) throw new Error("self-check failed: a baselined file at its count must not fail");
  write("src/a.ts", "await env.AI.run('a');\nawait env.AI.run('b');\nawait env.AI.run('c');\n");
  r = scan(root);
  if (!r.grew.includes("src/a.ts")) throw new Error("self-check failed: a new call site in a baselined file must fail");
  write("src/a.ts", "await env.AI.run('a');\n");
  r = scan(root);
  if (!r.shrank.includes("src/a.ts")) throw new Error("self-check failed: a removed call site must show as burn-down");
  write("src/b.ts", "await env.AI.run('z');\n");
  r = scan(root);
  if (!r.newFiles.includes("src/b.ts")) throw new Error("self-check failed: a brand-new violating file must fail");

  // Scanning nothing is not a pass.
  const empty = mkdtempSync(join(tmpdir(), "ai-guard-empty-"));
  if (scan(empty).scanned !== 0) throw new Error("self-check failed: an empty tree must scan 0 files");

  console.log(`ai-guard: self-check passed — ${cases.length + 5} cases`);
  return 0;
}

function main(args) {
  const root = args.find((a) => !a.startsWith("--")) ?? ".";
  const r = scan(root);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ violations: r.violations, counts: r.counts, newFiles: r.newFiles, grew: r.grew, shrank: r.shrank }, null, 2));
  } else {
    for (const v of r.violations) console.log(`${v.file}:${v.line}: ${v.rule}: ${v.message}`);
  }

  if (args.includes("--update-baseline")) return updateBaseline(root, r.counts, r.baseline, args.includes("--force"));

  const total = r.violations.length;
  console.error(
    `ai-guard: ${total} violation(s) in ${Object.keys(r.counts).length} file(s) — scanned ${r.scanned} file(s)` +
      `${r.hasConfig ? " · roots from .ai-guard.json" : ` · no ${CONFIG}, roots defaulted to ${SCAN_DEFAULT.join(", ")}`}` +
      `${Object.keys(r.baseline).length ? ` · baseline allows ${Object.values(r.baseline).reduce((a, b) => a + b, 0)}` : ""}`,
  );

  // Each of these says the verdict covers less than it claims, so none of them is a pass.
  if (r.unparseable.length) {
    console.error(`ai-guard: could not parse ${r.unparseable.join(", ")} — the ai binding in it was NOT checked. Fix the config.`);
    return 2;
  }
  if (r.missing.length) {
    console.error(`ai-guard: scan root(s) ${r.missing.map((d) => `"${d}"`).join(", ")} are in ${CONFIG} but do not exist, and were skipped in silence.`);
    return 2;
  }
  if (!r.scanned) {
    console.error(`ai-guard: scanned 0 files under "${root}" — nothing was checked, so this is not a pass. Check the path and \`include\` in ${CONFIG}.`);
    return 2;
  }

  if (r.shrank.length) {
    console.error(`ai-guard: ${r.shrank.length} file(s) improved since the baseline — re-record it with \`node scripts/ai-guard.mjs --update-baseline\`.`);
  }
  if (r.newFiles.length || r.grew.length) {
    console.error(
      `ai-guard: FAILED — ${r.newFiles.length} new violating file(s)${r.newFiles.length ? ` (${r.newFiles.join(", ")})` : ""}` +
        `${r.grew.length ? ` and ${r.grew.length} file(s) with more call sites than the baseline (${r.grew.join(", ")})` : ""}.` +
        ` Every AI call goes through core-guardian — see the header of this script for the three doors.`,
    );
    return args.includes("--warn") ? 0 : 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ai-guard.mjs")) {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) process.exit(selfCheck());
  process.exit(main(args));
}