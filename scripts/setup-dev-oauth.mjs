#!/usr/bin/env node
/**
 * @fileoverview Set up Google OAuth for the DEV Worker (google-workspace-mcp-dev):
 * validate both OAuth client files, check and repair their Google Cloud side,
 * then push the 4 Worker secrets and open the sign-in pages.
 *
 * Run it from anywhere (it finds the repo from its own path):
 *   node /path/to/google-workspace-mcp/scripts/setup-dev-oauth.mjs
 *   pnpm --dir /path/to/google-workspace-mcp run oauth:dev-setup
 *
 * Steps, per OAuth client (the shared one and the per-account one):
 *  1. Read the client file ({ "web": { client_id, client_secret, project_id, redirect_uris } }).
 *  2. gcloud: the project exists, the Google APIs the Worker calls are enabled
 *     (offers to enable missing ones), and — when the client is an IAM OAuth
 *     client — its allowed redirect URIs (fixed with `gcloud iam oauth-clients update`).
 *  3. Live check against Google (no sign-in, nothing stored):
 *       - token endpoint with a dummy code: `invalid_grant` = id + secret are valid;
 *         `invalid_client` = wrong secret or unknown client.
 *       - authorization endpoint for each required redirect URI: a redirect to the
 *         sign-in page = URI registered; `/signin/oauth/error` with
 *         `redirect_uri_mismatch` = not registered.
 *  4. Not registered and not an IAM client: Google has NO API or gcloud command
 *     for the redirect URIs of a normal "Web application" client, so the script
 *     opens that client's Console page, prints the URIs to add, waits for you,
 *     and checks again (Google can take a few minutes to apply a change).
 *  5. When every check passes: `wrangler secret bulk --env dev` from the repo
 *     root (values go through stdin, never argv or the log), then
 *     `wrangler secret list --env dev` to confirm the 4 names.
 *  6. Opens the dev sign-in page for each account. With WORKER_API_KEY in the
 *     environment and --verify-signin, it waits until /api/accounts lists both.
 *
 * SAFETY: only the dev environment is allowed. The script reads the dev
 * Worker name from wrangler.jsonc and refuses to continue unless it ends in
 * "-dev". It never touches the production Worker.
 *
 * Flags:
 *   --shared <file>              Shared OAuth client (GOOGLE_CLIENT_ID/SECRET).
 *   --account-creds <file>       Per-account OAuth client.
 *   --account <email>            Account that uses --account-creds (default justin@126colby.com).
 *   --shared-gcloud-account <e>  gcloud --account for the shared client's project.
 *   --account-gcloud-account <e> gcloud --account for the per-account client's project.
 *   --yes                        Do not ask: enable missing APIs and push secrets.
 *   --dry-run                    Check only; change nothing (no gcloud writes, no secrets).
 *   --skip-gcloud                Skip the gcloud checks (live Google checks still run).
 *   --no-open                    Do not open browser pages.
 *   --wait-seconds <n>           How long to keep re-checking after a Console fix (default 300).
 *   --verify-signin              After the secrets, wait until both accounts are signed in.
 *
 * @example
 *   node scripts/setup-dev-oauth.mjs --dry-run
 *   node scripts/setup-dev-oauth.mjs --yes --verify-signin
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULTS = {
  shared: "/Volumes/Projects/gcloud_creds/google_workspace_mcp/jmbish04_google_workspace_mcp.json",
  sharedAccount: "jmbish04@gmail.com",
  accountCreds: "/Volumes/Projects/gcloud_creds/google_workspace_mcp/justin126colby_google_workspace_mcp.json",
  account: "justin@126colby.com",
  waitSeconds: 300,
};

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google APIs the Worker calls with these OAuth clients (from src/backend/mcp/scopes.ts). */
export const REQUIRED_SERVICES = [
  "drive.googleapis.com",
  "docs.googleapis.com",
  "sheets.googleapis.com",
  "slides.googleapis.com",
  "calendar-json.googleapis.com",
  "gmail.googleapis.com",
  "script.googleapis.com",
  "forms.googleapis.com",
  "people.googleapis.com",
];
/** Only useful for a Google Workspace account (directory.readonly scope). */
export const WORKSPACE_SERVICES = ["admin.googleapis.com"];
/** Used by some features; reported, never required. */
export const OPTIONAL_SERVICES = ["workspaceevents.googleapis.com", "pubsub.googleapis.com"];

/** OAuth error codes Google can put in a sign-in error redirect. */
const AUTH_ERROR_CODES = [
  "redirect_uri_mismatch",
  "invalid_client",
  "deleted_client",
  "disabled_client",
  "unauthorized_client",
  "invalid_request",
  "access_denied",
  "admin_policy_enforced",
  "org_internal",
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Read a Google OAuth client file.
 *
 * @param {unknown} json - parsed file content
 * @returns {{ clientId: string, clientSecret: string, projectId: string|null, type: "web"|"installed"|"flat", redirectUris: string[] }}
 * @throws Error when the file has no client_id / client_secret
 */
export function parseClientFile(json) {
  const j = /** @type {any} */ (json ?? {});
  const type = j.web ? "web" : j.installed ? "installed" : "flat";
  const node = j.web ?? j.installed ?? j;
  if (!node.client_id || !node.client_secret) {
    throw new Error('no client_id / client_secret (expected { "web": { client_id, client_secret, ... } })');
  }
  return {
    clientId: String(node.client_id),
    clientSecret: String(node.client_secret),
    projectId: node.project_id ? String(node.project_id) : null,
    type,
    redirectUris: Array.isArray(node.redirect_uris) ? node.redirect_uris.map(String) : [],
  };
}

/**
 * Redirect URIs a client needs on the dev Worker.
 * The shared client serves /api/auth/google/oauth/callback (multi-account
 * sign-in) AND /auth/google/callback (browser login and the MCP OAuth
 * "Sign in with Google" door). A per-account client serves only the first.
 *
 * @param {string} baseUrl - dev Worker origin, e.g. https://google-workspace-mcp-dev.hacolby.workers.dev
 * @param {"shared"|"account"} role
 * @returns {string[]}
 */
export function requiredRedirects(baseUrl, role) {
  const base = baseUrl.replace(/\/+$/, "");
  const list = [`${base}/api/auth/google/oauth/callback`];
  if (role === "shared") list.push(`${base}/auth/google/callback`);
  return list;
}

/**
 * Union of two redirect lists, existing order first, no duplicates.
 *
 * @param {string[]} existing
 * @param {string[]} required
 * @returns {string[]}
 */
export function mergeRedirects(existing, required) {
  return [...new Set([...(existing ?? []), ...required])];
}

/**
 * Classify the authorization endpoint's answer for one client + redirect URI.
 * Measured 2026-10-08: a registered URI → 302 to accounts.google.com/v3/signin/…;
 * a problem → 302 to /signin/oauth/error?authError=<base64url> whose payload
 * names the code (redirect_uri_mismatch, invalid_client, …).
 *
 * @param {number} status - HTTP status
 * @param {string|null} location - Location header
 * @param {string} [body] - response body (for a 200/400 HTML error page)
 * @returns {{ ok: boolean, code: string, detail: string }}
 */
export function classifyAuthProbe(status, location, body = "") {
  if (status >= 300 && status < 400 && location) {
    let url;
    try {
      url = new URL(location, "https://accounts.google.com");
    } catch {
      return { ok: false, code: "unknown", detail: `bad Location: ${location}` };
    }
    if (url.pathname.includes("/signin/oauth/error")) {
      const blob = url.searchParams.get("authError") ?? "";
      const text = decodeBase64Url(blob);
      const code = AUTH_ERROR_CODES.find((c) => text.includes(c)) ?? "oauth_error";
      return { ok: false, code, detail: readable(text) };
    }
    if (/\/(v3\/)?signin\/|\/ServiceLogin|\/signin\/oauth\/(consent|v2)|\/AccountChooser/i.test(url.pathname)) {
      return { ok: true, code: "ok", detail: "Google shows its sign-in page for this redirect URI" };
    }
    return { ok: false, code: "unknown", detail: `unexpected redirect to ${url.origin}${url.pathname}` };
  }
  const code = AUTH_ERROR_CODES.find((c) => body.includes(c));
  return { ok: false, code: code ?? "unknown", detail: `HTTP ${status}${code ? "" : " without a known OAuth error"}` };
}

/**
 * Classify the token endpoint's answer to a dummy authorization code.
 * `invalid_grant` means Google accepted the client id AND secret and only
 * refused the (fake) code.
 *
 * @param {{ error?: string, error_description?: string }} json
 * @returns {{ ok: boolean, code: string, detail: string }}
 */
export function classifyTokenProbe(json) {
  const error = json?.error ?? "";
  const desc = json?.error_description ?? "";
  if (error === "invalid_grant") return { ok: true, code: "ok", detail: "client id and secret accepted" };
  if (error === "invalid_client" && /secret/i.test(desc)) return { ok: false, code: "bad_secret", detail: desc };
  if (error === "invalid_client" && /not found/i.test(desc)) return { ok: false, code: "unknown_client", detail: desc };
  if (error === "invalid_client") return { ok: false, code: "invalid_client", detail: desc || error };
  return { ok: false, code: error || "unknown", detail: desc || JSON.stringify(json) };
}

/**
 * Worker secret names for a client role.
 *
 * @param {"shared"|"account"} role
 * @param {string} [email] - account email (role "account")
 * @returns {{ id: string, secret: string }}
 */
export function secretNames(role, email) {
  if (role === "shared") return { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" };
  const suffix = String(email).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return { id: `GOOGLE_OAUTH_CLIENT_ID_${suffix}`, secret: `GOOGLE_OAUTH_CLIENT_SECRET_${suffix}` };
}

/**
 * Console pages where a normal OAuth client's redirect URIs are edited.
 *
 * @param {string} clientId
 * @param {string|null} projectId
 * @returns {string[]} new Google Auth Platform page first, then the classic Credentials page
 */
export function consoleUrls(clientId, projectId) {
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
  return [
    `https://console.cloud.google.com/auth/clients/${encodeURIComponent(clientId)}${q}`,
    `https://console.cloud.google.com/apis/credentials/oauthclient/${encodeURIComponent(clientId)}${q}`,
  ];
}

/** @param {string} s */
function decodeBase64Url(s) {
  try {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
  } catch {
    return "";
  }
}

/** Printable text of a decoded error payload. @param {string} s */
function readable(s) {
  return (s.match(/[\x20-\x7e]{6,}/g) ?? []).join(" | ").slice(0, 300);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfig = join(repoRoot, "wrangler.jsonc");

/** Parse CLI flags. @param {string[]} argv */
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return flags;
}

const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
const head = (m) => console.log(`\n== ${m}`);

/**
 * Run a command and capture its output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, cwd?: string, timeout?: number }} [opts]
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
}

/** gcloud with an optional --account. */
function gcloud(args, account) {
  return run("gcloud", account ? [...args, `--account=${account}`] : args);
}

/** The repo's wrangler, else npx. */
function wrangler(args, opts) {
  const local = join(repoRoot, "node_modules", ".bin", "wrangler");
  return existsSync(local) ? run(local, args, opts) : run("npx", ["--yes", "wrangler", ...args], opts);
}

/** Open a URL in the default browser (macOS open / Linux xdg-open). */
function openUrl(url, flags) {
  if (flags["no-open"]) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawnSync(cmd, [url], { stdio: "ignore" });
}

/** Ask a yes/no question (default no). Non-interactive → false unless --yes. */
async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ? ${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

/** Wait for Enter (interactive only). */
async function pause(message) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`  > ${message} `);
  rl.close();
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (id) => `${id.slice(0, 14)}…`;

// ---------------------------------------------------------------------------
// Live Google checks
// ---------------------------------------------------------------------------

/** Token endpoint probe with a dummy code. */
async function probeSecret(client, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: "4/0-setup-dev-oauth-dummy-code",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  return classifyTokenProbe(await res.json().catch(() => ({})));
}

/** Authorization endpoint probe for one redirect URI (no redirect is followed). */
async function probeRedirect(client, redirectUri) {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    access_type: "offline",
    prompt: "consent",
  });
  const res = await fetch(`${AUTH_URL}?${params}`, { redirect: "manual" });
  const body = res.status >= 300 && res.status < 400 ? "" : await res.text().catch(() => "");
  return classifyAuthProbe(res.status, res.headers.get("location"), body);
}

/** Probe every required redirect; returns the URIs that fail. */
async function failingRedirects(client, uris) {
  const failing = [];
  for (const uri of uris) {
    const r = await probeRedirect(client, uri);
    if (r.ok) ok(`redirect registered: ${uri}`);
    else {
      bad(`redirect ${r.code}: ${uri}${r.code === "redirect_uri_mismatch" ? "" : ` (${r.detail})`}`);
      failing.push({ uri, ...r });
    }
  }
  return failing;
}

// ---------------------------------------------------------------------------
// gcloud checks
// ---------------------------------------------------------------------------

/**
 * gcloud side of one client: project, enabled APIs, IAM OAuth client lookup.
 *
 * @returns {Promise<{ iamClient: { id: string, allowedRedirectUris: string[] } | null, ok: boolean }>}
 */
async function gcloudChecks(c, flags) {
  if (flags["skip-gcloud"]) {
    warn("gcloud checks skipped (--skip-gcloud)");
    return { iamClient: null, ok: true };
  }
  if (!c.projectId) {
    warn("the client file has no project_id; gcloud checks skipped");
    return { iamClient: null, ok: true };
  }
  const ver = gcloud(["--version"]);
  if (ver.error || ver.status !== 0) {
    warn("gcloud is not installed or not on PATH; gcloud checks skipped");
    return { iamClient: null, ok: true };
  }
  const who = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], c.gcloudAccount);
  ok(`gcloud account: ${(c.gcloudAccount || who.stdout.trim() || "(none active)").split("\n")[0]}`);

  const proj = gcloud(["projects", "describe", c.projectId, "--format=json"], c.gcloudAccount);
  if (proj.status !== 0) {
    bad(`cannot read project ${c.projectId}: ${proj.stderr.trim().split("\n").pop()}`);
    console.log(`    Sign in with an account that owns it: gcloud auth login <email>, then pass --${c.role}-gcloud-account <email>.`);
    return { iamClient: null, ok: false };
  }
  const state = JSON.parse(proj.stdout).lifecycleState;
  if (state !== "ACTIVE") {
    bad(`project ${c.projectId} is ${state}`);
    return { iamClient: null, ok: false };
  }
  ok(`project ${c.projectId} is ACTIVE`);

  const enabled = gcloud(["services", "list", "--enabled", `--project=${c.projectId}`, "--format=value(config.name)"], c.gcloudAccount);
  if (enabled.status !== 0) {
    warn(`cannot list enabled APIs: ${enabled.stderr.trim().split("\n").pop()}`);
  } else {
    const on = new Set(enabled.stdout.split(/\s+/).filter(Boolean));
    const need = [...REQUIRED_SERVICES, ...(c.workspace ? WORKSPACE_SERVICES : [])];
    const missing = need.filter((s) => !on.has(s));
    const optionalOff = OPTIONAL_SERVICES.filter((s) => !on.has(s));
    if (!missing.length) ok(`all ${need.length} required Google APIs are enabled`);
    else {
      bad(`APIs not enabled: ${missing.join(", ")}`);
      if (flags["dry-run"]) warn("--dry-run: not enabling them");
      else if (await confirm(`Enable ${missing.length} API(s) in ${c.projectId} now?`, flags)) {
        const en = gcloud(["services", "enable", ...missing, `--project=${c.projectId}`], c.gcloudAccount);
        if (en.status === 0) ok(`enabled: ${missing.join(", ")}`);
        else bad(`gcloud services enable failed: ${en.stderr.trim().split("\n").pop()}`);
      }
    }
    if (optionalOff.length) warn(`optional APIs not enabled (only some features need them): ${optionalOff.join(", ")}`);
  }

  // Only IAM OAuth clients are visible to gcloud; a normal "Web application"
  // client (…apps.googleusercontent.com) is not, and has no redirect URI API.
  const iam = gcloud(["iam", "oauth-clients", "list", `--project=${c.projectId}`, "--location=global", "--format=json"], c.gcloudAccount);
  if (iam.status === 0) {
    const list = JSON.parse(iam.stdout || "[]");
    const hit = list.find((x) => x.clientId === c.clientId);
    if (hit) {
      ok("client is an IAM OAuth client: gcloud can manage its redirect URIs");
      return { iamClient: { id: String(hit.name).split("/").pop(), allowedRedirectUris: hit.allowedRedirectUris ?? [] }, ok: true };
    }
  }
  ok("client is a standard OAuth web client (redirect URIs are edited in the Console, not gcloud)");
  return { iamClient: null, ok: true };
}

// ---------------------------------------------------------------------------
// One client, end to end
// ---------------------------------------------------------------------------

async function validateClient(c, baseUrl, flags) {
  head(`${c.label}: ${c.file}`);
  ok(`client ${mask(c.clientId)} in project ${c.projectId ?? "(unknown)"} (${c.type} client)`);
  if (c.type === "installed") {
    bad('this is a "Desktop app" client; it cannot use https redirect URIs. Create a "Web application" client instead.');
    return false;
  }
  const uris = requiredRedirects(baseUrl, c.role);
  const notInFile = uris.filter((u) => !c.redirectUris.includes(u));
  if (notInFile.length) warn(`the downloaded file does not list ${notInFile.length} required URI(s); the live check below decides`);

  const g = await gcloudChecks(c, flags);

  const secret = await probeSecret(c, uris[0]);
  if (!secret.ok) {
    bad(`client id / secret refused by Google: ${secret.code} — ${secret.detail}`);
    console.log("    Download the client file again from the Console (or reset the secret there) and re-run.");
    return false;
  }
  ok(`Google accepts the client id and secret (${secret.detail})`);

  const waitSeconds = Number(flags["wait-seconds"] ?? DEFAULTS.waitSeconds);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failing = await failingRedirects(c, uris);
    if (!failing.length) return g.ok;
    const fixable = failing.filter((f) => f.code === "redirect_uri_mismatch");
    if (fixable.length !== failing.length) {
      bad("a check failed for a reason other than a missing redirect URI; see the codes above");
      return false;
    }
    if (flags["dry-run"]) {
      warn("--dry-run: not fixing. Add the URIs above to the client and re-run.");
      return false;
    }
    if (g.iamClient) {
      const merged = mergeRedirects(g.iamClient.allowedRedirectUris, uris);
      if (await confirm(`Set ${merged.length} allowed redirect URI(s) on IAM client ${g.iamClient.id} with gcloud?`, flags)) {
        const up = gcloud(
          ["iam", "oauth-clients", "update", g.iamClient.id, `--project=${c.projectId}`, "--location=global", `--allowed-redirect-uris=${merged.join(",")}`],
          c.gcloudAccount,
        );
        if (up.status === 0) {
          ok("gcloud updated the redirect URIs");
          g.iamClient.allowedRedirectUris = merged;
        } else bad(`gcloud update failed: ${up.stderr.trim().split("\n").pop()}`);
      }
    } else {
      console.log(`\n    Add these Authorized redirect URIs to the client, then click Save:`);
      for (const f of fixable) console.log(`      ${f.uri}`);
      const [primary, classic] = consoleUrls(c.clientId, c.projectId);
      console.log(`    Console: ${primary}`);
      console.log(`    (classic page: ${classic})`);
      openUrl(primary, flags);
      const waited = await pause("Press Enter after you click Save…");
      if (!waited) {
        bad("not interactive: cannot wait for the Console change. Re-run after you save it.");
        return false;
      }
    }
    // Google applies a change within minutes; poll until the URIs pass.
    const deadline = Date.now() + waitSeconds * 1000;
    let pending = fixable.map((f) => f.uri);
    process.stdout.write(`    re-checking for up to ${waitSeconds}s `);
    while (pending.length && Date.now() < deadline) {
      await sleep(15_000);
      process.stdout.write(".");
      const still = [];
      for (const uri of pending) if (!(await probeRedirect(c, uri)).ok) still.push(uri);
      pending = still;
    }
    console.log("");
    if (!pending.length) ok("Google now accepts every required redirect URI");
    else warn(`attempt ${attempt}: still not accepted: ${pending.join(", ")}`);
  }
  const final = await failingRedirects(c, uris);
  return final.length === 0 && g.ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const envName = String(flags.env ?? "dev");
  if (envName !== "dev") {
    bad(`only --env dev is allowed (got "${envName}"). This script never writes production secrets.`);
    process.exit(2);
  }

  head("Dev Worker target");
  let workerName;
  let baseUrl;
  try {
    process.env.WRANGLER_LOG ??= "error"; // hide the env.dev "not inherited" notes
    const require = createRequire(join(repoRoot, "package.json"));
    const { unstable_readConfig } = require("wrangler");
    const cfg = unstable_readConfig({ config: wranglerConfig, env: envName });
    workerName = cfg.name;
    baseUrl = String(cfg.vars?.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  } catch (err) {
    bad(`cannot read ${wranglerConfig} with the repo's wrangler: ${err.message}`);
    console.log(`    Run \`pnpm install\` in ${repoRoot} first.`);
    process.exit(2);
  }
  if (!workerName?.endsWith("-dev") || !baseUrl.includes("-dev.")) {
    bad(`env "${envName}" resolves to Worker "${workerName}" at "${baseUrl}"; refusing (expected a -dev Worker).`);
    process.exit(2);
  }
  ok(`Worker ${workerName} at ${baseUrl}`);

  const clients = [
    {
      role: "shared",
      label: `Shared OAuth client (${DEFAULTS.sharedAccount} and browser login)`,
      file: String(flags.shared ?? DEFAULTS.shared),
      email: DEFAULTS.sharedAccount,
      gcloudAccount: flags["shared-gcloud-account"] ? String(flags["shared-gcloud-account"]) : undefined,
      workspace: false,
    },
    {
      role: "account",
      label: `Per-account OAuth client (${flags.account ?? DEFAULTS.account})`,
      file: String(flags["account-creds"] ?? DEFAULTS.accountCreds),
      email: String(flags.account ?? DEFAULTS.account),
      gcloudAccount: flags["account-gcloud-account"] ? String(flags["account-gcloud-account"]) : undefined,
      workspace: !/@(gmail|googlemail)\.com$/i.test(String(flags.account ?? DEFAULTS.account)),
    },
  ];

  for (const c of clients) {
    if (!existsSync(c.file)) {
      bad(`file not found: ${c.file}`);
      process.exit(1);
    }
    try {
      Object.assign(c, parseClientFile(JSON.parse(readFileSync(c.file, "utf8"))));
    } catch (err) {
      bad(`${c.file}: ${err.message}`);
      process.exit(1);
    }
  }
  if (clients[0].clientId === clients[1].clientId) warn("both files hold the same OAuth client");

  let allValid = true;
  for (const c of clients) allValid = (await validateClient(c, baseUrl, flags)) && allValid;
  if (!allValid) {
    head("Result");
    bad("validation failed; no secrets were pushed. Fix the items marked ✖ and run the script again.");
    process.exit(1);
  }

  const secrets = {};
  for (const c of clients) {
    const n = secretNames(c.role, c.email);
    secrets[n.id] = c.clientId;
    secrets[n.secret] = c.clientSecret;
  }
  head(`Worker secrets for ${workerName}`);
  for (const k of Object.keys(secrets)) console.log(`    ${k}`);
  if (flags["dry-run"]) {
    warn("--dry-run: secrets not pushed");
    process.exit(0);
  }
  const me = wrangler(["whoami"]);
  if (me.status !== 0) {
    bad("wrangler is not logged in. Run `npx wrangler login` and re-run.");
    process.exit(1);
  }
  if (!(await confirm(`Push ${Object.keys(secrets).length} secrets to ${workerName}?`, flags))) {
    warn("not pushed (answer y or pass --yes)");
    process.exit(1);
  }
  const put = wrangler(["secret", "bulk", "--env", envName, "--config", wranglerConfig], { input: JSON.stringify(secrets) });
  if (put.status !== 0) {
    bad(`wrangler secret bulk failed (exit ${put.status}): ${(put.stderr || put.stdout).trim().split("\n").slice(-3).join(" ")}`);
    process.exit(1);
  }
  const list = wrangler(["secret", "list", "--env", envName, "--config", wranglerConfig, "--format", "json"]);
  const names = new Set();
  try {
    for (const s of JSON.parse(list.stdout.slice(list.stdout.indexOf("[")))) names.add(s.name);
  } catch {
    /* fall through to the check below */
  }
  const missingSecrets = Object.keys(secrets).filter((k) => !names.has(k));
  if (missingSecrets.length) {
    bad(`secret list does not show: ${missingSecrets.join(", ")}`);
    process.exit(1);
  }
  ok(`${Object.keys(secrets).length} secrets are set on ${workerName} (values not shown)`);

  head("Sign in (one browser login per account)");
  for (const c of clients) {
    const url = `${baseUrl}/api/auth/google/oauth/start?label=${encodeURIComponent(c.email)}`;
    console.log(`    ${c.email}: ${url}`);
    openUrl(url, flags);
  }

  if (flags["verify-signin"]) {
    const key = process.env.WORKER_API_KEY;
    if (!key) warn("--verify-signin needs WORKER_API_KEY in the environment; skipped");
    else {
      const want = clients.map((c) => c.email.toLowerCase());
      const deadline = Date.now() + 10 * 60_000;
      process.stdout.write("    waiting for both sign-ins (up to 10 min) ");
      let have = [];
      while (Date.now() < deadline) {
        const res = await fetch(`${baseUrl}/api/accounts`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
        const json = res?.ok ? await res.json().catch(() => ({})) : {};
        have = (json.data ?? []).filter((a) => a.status !== "revoked").map((a) => String(a.email).toLowerCase());
        if (want.every((e) => have.includes(e))) break;
        process.stdout.write(".");
        await sleep(10_000);
      }
      console.log("");
      for (const e of want) (have.includes(e) ? ok : bad)(`${e} ${have.includes(e) ? "is signed in on dev" : "is not signed in yet"}`);
    }
  }
  head("Done");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    bad(err?.stack ?? String(err));
    process.exit(1);
  });
}
