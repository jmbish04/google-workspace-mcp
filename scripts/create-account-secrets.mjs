#!/usr/bin/env node
/**
 * Set the per-account Google OAuth Worker secrets for ONE account (e.g.
 * justin@126colby.com) from that account's Google OAuth client creds JSON,
 * using `wrangler secret bulk` (one non-interactive call — same effect as
 * running `wrangler secret put` per key, without the TTY prompt).
 *
 * These are plain Worker secrets (NOT a Secrets Store binding), read at runtime
 * as `env.GOOGLE_OAUTH_*_<SUFFIX>` (see src/backend/utils/secrets.ts →
 * accountSecretSuffix / getGoogleOAuthClientIdForAccount).
 *
 * Accepted creds JSON shapes:
 *   - OAuth client:      { "web"|"installed": { client_id, client_secret, ... } }
 *   - Authorized user:   { client_id, client_secret, refresh_token, type:"authorized_user" }
 * A refresh_token, if present at the top level or nested, is stored too — then
 * the account works immediately with NO interactive login.
 *
 * Usage:
 *   node scripts/create-account-secrets.mjs [path/to/creds.json] [--account you@example.com]
 *   pnpm secrets:account -- --account justin@126colby.com /path/to/creds.json
 *
 * Defaults: account justin@126colby.com, creds file the path below.
 *
 * Flags:
 *   --account <email>  Account these creds belong to (drives the secret suffix).
 *   --local-only       Only append .dev.vars; do NOT push remote secrets.
 *   --no-dev-vars      Only push remote secrets; do NOT touch .dev.vars.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_ACCOUNT = "justin@126colby.com";
const DEFAULT_CREDS = "/Volumes/Projects/gcloud_creds/google-workspace-mcp-justin-126colby.json";
const WORKER_NAME = "google-workspace-mcp";
const TIMEOUT_MS = 90_000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const localWrangler = join(repoRoot, "node_modules", ".bin", "wrangler");
const wranglerBin = existsSync(localWrangler) ? localWrangler : "npx";
const wranglerArgs = (rest) => (wranglerBin === "npx" ? ["wrangler", ...rest] : rest);

const argv = process.argv.slice(2);
const localOnly = argv.includes("--local-only");
const noDevVars = argv.includes("--no-dev-vars");
const accountFlagIdx = argv.indexOf("--account");
const account = (accountFlagIdx !== -1 ? argv[accountFlagIdx + 1] : process.env.ACCOUNT) ?? DEFAULT_ACCOUNT;
const positional = argv.filter((a, i) => !a.startsWith("--") && i !== accountFlagIdx + 1);
const credsPath = positional[0] ?? process.env.CREDS_FILE ?? DEFAULT_CREDS;

/** Normalize an email to a secret-name suffix (matches accountSecretSuffix in the worker). */
function accountSecretSuffix(email) {
  return email
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

if (!account.includes("@")) {
  console.error(`✖ --account must be an email address (got: ${account})`);
  process.exit(1);
}
if (!existsSync(credsPath)) {
  console.error(`✖ Creds file not found: ${credsPath}`);
  console.error(`  Pass a path or set CREDS_FILE. Expected ${account}'s Google OAuth client JSON.`);
  process.exit(1);
}

let creds;
try {
  creds = JSON.parse(readFileSync(credsPath, "utf8"));
} catch (err) {
  console.error(`✖ Could not parse ${credsPath}: ${err.message}`);
  process.exit(1);
}

// Accept web/installed OAuth-client shape or a top-level authorized_user shape.
const node = creds.web ?? creds.installed ?? creds;
const clientId = node.client_id;
const clientSecret = node.client_secret;
const refreshToken = node.refresh_token ?? creds.refresh_token;

if (!clientId || !clientSecret) {
  console.error(`✖ ${credsPath} has no client_id / client_secret.`);
  console.error(`  Expected an OAuth client JSON ({web|installed:{client_id,client_secret}})`);
  console.error(`  or an authorized_user JSON ({client_id,client_secret,refresh_token}).`);
  process.exit(1);
}

const suffix = accountSecretSuffix(account);
const SECRETS = {
  [`GOOGLE_OAUTH_CLIENT_ID_${suffix}`]: clientId,
  [`GOOGLE_OAUTH_CLIENT_SECRET_${suffix}`]: clientSecret,
};
if (refreshToken) SECRETS[`GOOGLE_OAUTH_REFRESH_TOKEN_${suffix}`] = refreshToken;

console.log(`Account : ${account}`);
console.log(`Suffix  : ${suffix}`);
console.log(`Secrets : ${Object.keys(SECRETS).join(", ")}`);
console.log(refreshToken ? "  (refresh_token present → account works without interactive login)" : "  (no refresh_token → run the login flow once, see below)");

if (!localOnly) {
  console.log(`→ Pushing ${Object.keys(SECRETS).length} secrets to Worker "${WORKER_NAME}" via wrangler secret bulk…`);
  const res = spawnSync(wranglerBin, wranglerArgs(["secret", "bulk", "--name", WORKER_NAME]), {
    input: JSON.stringify(SECRETS),
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  if (res.error?.code === "ETIMEDOUT" || res.signal === "SIGTERM") {
    console.error(`\n✖ wrangler timed out after ${TIMEOUT_MS / 1000}s. Check \`wrangler whoami\` / network and retry.`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`\n✖ wrangler secret bulk exited ${res.status}.`);
    console.error(`  If the Worker doesn't exist yet, deploy once first: pnpm run deploy`);
    process.exit(res.status ?? 1);
  }
  console.log(`  ✓ ${Object.keys(SECRETS).join(", ")} set (values hidden)`);
}

if (!noDevVars) {
  const lines = Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`);
  appendFileSync(join(repoRoot, ".dev.vars"), `\n# ${account}\n${lines.join("\n")}\n`, { mode: 0o600 });
  console.log("  ✓ appended per-account secrets to .dev.vars (gitignored, local dev)");
}

console.log("");
console.log("Done. Next:");
if (!refreshToken) {
  console.log(`  • Log in once to mint ${account}'s refresh token (uses that account's client):`);
  console.log(`      https://google-workspace-mcp.hacolby.workers.dev/api/auth/google/oauth/start?label=${encodeURIComponent(account)}`);
  console.log(`  • Ensure the redirect URI is authorized in ${account}'s Google Cloud project:`);
  console.log(`      https://google-workspace-mcp.hacolby.workers.dev/api/auth/google/oauth/callback`);
}
console.log(`  • ${account} now resolves via OAuth (DWD is disabled for it); tools use as_user="${account}".`);
