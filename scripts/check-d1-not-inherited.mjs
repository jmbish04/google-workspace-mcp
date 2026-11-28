#!/usr/bin/env node
// colby-ecosystem: managed script — edit it in jmbish04/colby-ecosystem/templates/scripts/,
// never here. `pull-agents` overwrites this file.
/**
 * check-d1-not-inherited.mjs — refuse to deploy while wrangler.jsonc is bound to a
 * D1 database that is not this project's own.
 *
 * WHY THIS EXISTS
 *
 * Measured 2026-11-02: `database_id` d555f8ce-77c9-4c82-be80-de95b8d9c003 is the
 * account's spend-governor database — core-guardian's production D1, holding
 * billable_usage, alert_rules, cf_billing_*, workers_ai_daily_neurons,
 * ai_routing_decisions, spend_rollup and about 115 more tables (123 tables,
 * 400.2 MB). Cloudflare still lists it under the name it was created with,
 * core-template-cfw-assets-astro-shadcn, because a template created it and
 * core-guardian adopted it. wrangler's `database_name` is cosmetic; the uuid is
 * what binds. That is why five Workers pointed at this one database while each
 * `wrangler.jsonc` claimed a different `database_name`, and why every app
 * scaffolded from that template ran its own Drizzle migrations against the
 * Worker that holds the account's shut-down switches. A server-side search
 * found the uuid on 13 default branches.
 *
 * THE RULES — two, because two different mistakes put a foreign uuid here.
 *
 * 1. NEVER a known-foreign database, whatever this project is called. A copy that
 *    reverts wrangler.jsonc, or pastes an old id back, is caught by identity, not
 *    by inference. This is the rule that would have caught the live bug.
 *
 * 1a. EXCEPT its owner. Each FOREIGN entry names the one project that may bind
 *    it, matched against package.json's `name`. Rule 1 without this refused
 *    core-guardian's own production database, so the repo that owns the id was
 *    the only repo the check could never pass. See the note on FOREIGN below.
 *
 * 2. A template must carry a placeholder, not a uuid. While package.json's `name`
 *    is still a `core-template*` name, any uuid-shaped `database_id` is refused:
 *    a copy pasting a real id while still wearing the template's identity is
 *    almost certainly pasting the id it inherited. Renaming the package is the
 *    first thing anyone does to a copy, so it is the signal that separates "still
 *    the template" from "a real app".
 *
 * Usage:
 *   node scripts/check-d1-not-inherited.mjs               # gate a deploy or migration
 *   node scripts/check-d1-not-inherited.mjs --self-check  # prove the rules can fail
 *
 * Wire it into package.json so a deploy cannot skip it — `pull-agents` warns when
 * no script invokes it:
 *   "check:d1":       "node scripts/check-d1-not-inherited.mjs",
 *   "migrate:remote": "node scripts/check-d1-not-inherited.mjs && …",
 *   "deploy":         "node scripts/check-d1-not-inherited.mjs && …",
 *
 * ponytail: FOREIGN is a short denylist rather than an ownership lookup because
 * nothing offline can prove which Worker owns a uuid. Add an entry when a shared
 * database is found; an API call at deploy time would need a token this check
 * must not require.
 *
 * ponytail: `owner` is matched against package.json's `name`, the same offline
 * signal rule 2 uses, so a copy that renamed itself to the owner's name would
 * pass. That is not the bug this catches — the real one was copies KEEPING the
 * template's name — and the alternative is the API call above. If a copy ever
 * does impersonate an owner, the upgrade is to verify the binding against the
 * account at deploy time.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const WRANGLER = join(ROOT, "wrangler.jsonc");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Databases no project in this ecosystem may bind, each with the ONE project that
 * may. `owner` is matched against package.json's `name`.
 *
 * Without `owner` this list refuses the owner too, and the one repo where the
 * binding is correct is the one repo where the check can never pass. Measured
 * 2026-11-13: core-guardian's own `agents-sync` had failed on every branch since
 * 2026-11-11 — main included — on its own production database. A check that is
 * always red is one nobody reads, so a genuinely foreign binding would have
 * merged unnoticed behind it.
 */
export const FOREIGN = [
  {
    id: "d555f8ce-77c9-4c82-be80-de95b8d9c003",
    owner: "core-guardian",
    what:
      "core-guardian's PRODUCTION database (123 tables, 400.2 MB on 2026-11-02; " +
      "Cloudflare lists it as core-template-cfw-assets-astro-shadcn)",
  },
];

/** wrangler.jsonc is JSON with comments and trailing commas; strip both. */
export function parseJsonc(text) {
  const noComments = text.replace(
    /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('"') ? m : " "),
  );
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** Both rules, in one place, so the self-check can drive them. */
export function verdict({ packageName, databases }) {
  const list = databases || [];
  const ids = (d) => [d.database_id, d.preview_database_id].filter(Boolean).map((x) => String(x));

  const foreign = list.filter((d) =>
    ids(d).some((id) =>
      FOREIGN.some((f) => f.id === id.toLowerCase() && f.owner !== packageName),
    ),
  );

  const isTemplate = /^core-template/.test(packageName || "");
  const inherited = isTemplate
    ? list.filter((d) => ids(d).some((id) => UUID.test(id)) && !foreign.includes(d))
    : [];

  return { ok: foreign.length === 0 && inherited.length === 0, foreign, inherited };
}

function describe(d) {
  const preview = d.preview_database_id ? `, preview ${d.preview_database_id}` : "";
  return `  ${d.binding} -> ${d.database_name} (${d.database_id}${preview})`;
}

function main() {
  // A missing wrangler.jsonc is NOT a pass. This script only ships to repos that have
  // one, so its absence means either the wrong repo or a deleted config, and either
  // way nothing here has been checked. Say so and exit non-zero rather than printing
  // "ok" for a file that was never read.
  for (const [what, path] of [["package.json", PKG], ["wrangler.jsonc", WRANGLER]]) {
    if (!existsSync(path)) {
      console.error(
        `check-d1-not-inherited: no ${what} at ${path}, so nothing was checked.\n` +
          "Run it from a repo that has both, or drop this script if this is not a Worker repo.",
      );
      return 1;
    }
  }
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const wrangler = parseJsonc(readFileSync(WRANGLER, "utf8"));
  const result = verdict({ packageName: pkg.name, databases: wrangler.d1_databases });
  if (result.ok) {
    const n = (wrangler.d1_databases || []).length;
    console.log(`check-d1-not-inherited: ok (${n} d1 binding(s) in wrangler.jsonc)`);
    return 0;
  }
  const lines = ["check-d1-not-inherited: refusing to deploy."];
  if (result.foreign.length > 0) {
    lines.push(
      "",
      "wrangler.jsonc binds a database that belongs to another project:",
      ...result.foreign.map(describe),
      "",
      ...FOREIGN.map((f) => `  ${f.id} is ${f.what}; only "${f.owner}" may bind it`),
    );
  }
  if (result.inherited.length > 0) {
    lines.push(
      "",
      `This project still calls itself "${pkg.name}", so it is still the template, ` +
        "but wrangler.jsonc binds a real D1 database:",
      ...result.inherited.map(describe),
      "",
      "If you ARE the template, that id belongs in wrangler.jsonc as a placeholder.",
    );
  }
  lines.push(
    "",
    "Give this project its own database:",
    "  npx wrangler d1 create <your-app-name>",
    "then put the returned name and uuid in wrangler.jsonc (and rename this package",
    "if it is still a core-template* copy).",
  );
  console.error(lines.join("\n"));
  return 1;
}

function selfCheck() {
  const guardian = FOREIGN[0].id;
  const mine = "11111111-2222-3333-4444-555555555555";
  const pkgName = existsSync(PKG) ? JSON.parse(readFileSync(PKG, "utf8")).name : "core-template-x";
  const cases = [
    // [what, input, expected ok]
    [
      "guardian's database is refused however this project is named — the live bug",
      { packageName: "mcp-r2-sql", databases: [{ database_id: guardian }] },
      false,
    ],
    [
      "guardian's database is refused as a preview id too",
      { packageName: "some-app", databases: [{ database_id: mine, preview_database_id: guardian }] },
      false,
    ],
    [
      "an uppercase spelling of guardian's id is the same database",
      { packageName: "some-app", databases: [{ database_id: guardian.toUpperCase() }] },
      false,
    ],
    [
      "a template carrying any real uuid is refused",
      { packageName: "core-template-cf-reui", databases: [{ database_id: mine }] },
      false,
    ],
    [
      "the plural template name is a template too",
      { packageName: "core-templates-cf-astro-shadcn-mainline", databases: [{ database_id: mine }] },
      false,
    ],
    [
      "one real id among placeholders is still refused",
      {
        packageName: "core-template-x",
        databases: [{ database_id: "replace-me" }, { database_id: mine }],
      },
      false,
    ],
    [
      "the OWNER of a listed database may bind it — core-guardian's own config",
      { packageName: "core-guardian", databases: [{ database_id: guardian }] },
      true,
    ],
    [
      "a near-miss on the owner's name is still refused",
      { packageName: "core-guardian-logs", databases: [{ database_id: guardian }] },
      false,
    ],
    [
      "the owner exception does not rescue a template carrying the same id",
      { packageName: "core-template-cf-reui", databases: [{ database_id: guardian }] },
      false,
    ],
    [
      "a renamed copy with its own fresh uuid passes",
      { packageName: "my-new-app", databases: [{ database_id: mine }] },
      true,
    ],
    [
      "no d1 block at all passes",
      { packageName: "core-template-x", databases: undefined },
      true,
    ],
    [
      `a placeholder id under this project's name (${pkgName}) passes`,
      {
        packageName: pkgName,
        databases: [{ database_id: "replace-me-run-wrangler-d1-create" }],
      },
      true,
    ],
  ];
  for (const [what, input, expected] of cases) {
    const got = verdict(input).ok;
    if (got !== expected) {
      throw new Error(`self-check failed: ${what} (expected ok=${expected}, got ${got})`);
    }
  }
  // The parser has to survive the comments and trailing commas a wrangler.jsonc uses.
  const parsed = parseJsonc('{\n // a line comment with "a quote\n "a": 1, /* block */\n "b": [2,],\n}');
  if (parsed.a !== 1 || parsed.b.length !== 1) throw new Error("self-check failed: jsonc parsing");
  if (parseJsonc('{"url": "https://x/y//z"}').url !== "https://x/y//z") {
    throw new Error("self-check failed: a // inside a string is not a comment");
  }

  // The live config, when there is one. Printing WHICH of the two ran is the point:
  // a self-check that silently skipped the live config reads exactly like one that
  // passed it, and this file ships to every Worker repo, where the live config is
  // the only part that has ever caught a real bug.
  let liveNote = "no wrangler.jsonc beside this script, so the live config was NOT checked";
  if (existsSync(PKG) && existsSync(WRANGLER)) {
    const live = verdict({
      packageName: pkgName,
      databases: parseJsonc(readFileSync(WRANGLER, "utf8")).d1_databases,
    });
    if (!live.ok) {
      // A raw throw here would print a stack trace where the operator needs the
      // refusal: which uuid, what it belongs to, and how to get their own database.
      // The rules themselves already passed, so the live config is the finding.
      console.error("check-d1-not-inherited: the rule cases passed; this repo's own config does not.\n");
      return main();
    }
    liveNote = "this repo's own wrangler.jsonc parses and passes";
  }
  console.log(`check-d1-not-inherited: self-check passed (${cases.length} rule cases; ${liveNote})`);
  return 0;
}

process.exit(process.argv.includes("--self-check") ? selfCheck() : main());