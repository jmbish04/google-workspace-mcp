/**
 * E2E test for the Workspace Events pipeline.
 *
 * Default: POST /api/gws-health-check/run-e2e on the deployed worker, which
 * creates a folder, subscribes with descendants, creates a Google Doc inside
 * it, renames it, comments, deletes it, and polls D1 until Pub/Sub →
 * /api/webhooks/workspace has recorded events for that file.
 *
 * Usage:
 *   node scripts/test-workspace-events-e2e.mjs
 *   node scripts/test-workspace-events-e2e.mjs --results-only
 *   node scripts/test-workspace-events-e2e.mjs --configure-push
 *   node scripts/test-workspace-events-e2e.mjs --verify-push
 */
import { execFileSync } from "node:child_process";
import { getWorkerApiKey } from "./tokens.mjs";

const workerKey = getWorkerApiKey();
const BASE = "https://google-workspace-mcp.hacolby.workers.dev";
const GEMINI_PROJECT = "gen-lang-client-0933201592";
const WORKSPACE_PROJECT = "discovery-383518";
const LEGACY_WORKSPACE_PROJECT = "gen-lang-client-0933201592";
const WORKSPACE_SUB = "workspace-events-topic-sub";
const GEMINI_SUB = "gemini-usage-topic-sub";
const WORKSPACE_PUSH = `https://google-workspace-mcp.hacolby.workers.dev/api/webhooks/workspace?token=${encodeURIComponent(workerKey)}`;
const GEMINI_PUSH = `https://core-guardian.hacolby.workers.dev/api/webhooks/gemini-usage?token=${encodeURIComponent(workerKey)}`;

const args = new Set(process.argv.slice(2));

function authHeaders() {
  return {
    Authorization: `Bearer ${workerKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function gcloud(argsList) {
  return execFileSync("gcloud", argsList, { encoding: "utf8" }).trim();
}

async function configurePush() {
  console.log("Configuring Pub/Sub push endpoints…");
  console.log(`  ${WORKSPACE_PROJECT}/${WORKSPACE_SUB} → google-workspace-mcp /api/webhooks/workspace`);
  gcloud([
    "pubsub", "subscriptions", "modify-push-config", WORKSPACE_SUB,
    "--project", WORKSPACE_PROJECT,
    "--push-endpoint", WORKSPACE_PUSH,
  ]);
  console.log(`  ${LEGACY_WORKSPACE_PROJECT}/${WORKSPACE_SUB} → google-workspace-mcp /api/webhooks/workspace`);
  gcloud([
    "pubsub", "subscriptions", "modify-push-config", WORKSPACE_SUB,
    "--project", LEGACY_WORKSPACE_PROJECT,
    "--push-endpoint", WORKSPACE_PUSH,
  ]);
  console.log(`  ${GEMINI_PROJECT}/${GEMINI_SUB} → core-guardian /api/webhooks/gemini-usage`);
  gcloud([
    "pubsub", "subscriptions", "modify-push-config", GEMINI_SUB,
    "--project", GEMINI_PROJECT,
    "--push-endpoint", GEMINI_PUSH,
  ]);
  console.log("✅ Push configs updated.\n");
}

function describePush(name, project) {
  const json = gcloud([
    "pubsub", "subscriptions", "describe", name,
    "--project", project,
    "--format", "json",
  ]);
  const parsed = JSON.parse(json);
  const endpoint = parsed.pushConfig?.pushEndpoint ?? "(none)";
  const redacted = endpoint.replace(/([?&]token=)[^&]+/i, "$1***");
  return { name, project, endpoint: redacted, ackDeadline: parsed.ackDeadlineSeconds };
}

async function verifyPush() {
  console.log("Current Pub/Sub push endpoints:");
  const targets = [
    [WORKSPACE_SUB, WORKSPACE_PROJECT],
    [WORKSPACE_SUB, LEGACY_WORKSPACE_PROJECT],
    [GEMINI_SUB, GEMINI_PROJECT],
  ];
  for (const [name, project] of targets) {
    const info = describePush(name, project);
    console.log(`  ${info.project}/${info.name}`);
    console.log(`    endpoint: ${info.endpoint}`);
    console.log(`    ackDeadlineSeconds: ${info.ackDeadline}`);
  }
  console.log("");
}

async function listResults() {
  const res = await fetch(`${BASE}/api/gws-health-check/results?limit=5`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    console.error(`❌ GET /results HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`Recent runs: ${(data.runs ?? []).length}`);
  for (const run of data.runs ?? []) {
    const icon = run.status === "ok" ? "✅" : "❌";
    console.log(`  ${icon} ${run.runId}  ${run.health ?? run.status}  ${run.startedAt}`);
  }
}

function printRun(data, elapsedSec) {
  console.log(`Overall: ${data.status === "ok" ? "✅ PASS" : "❌ FAIL"}  health=${data.health ?? "?"}  (${elapsedSec}s)\n`);
  if (data.docId) console.log(`Test Doc ID: ${data.docId}`);
  if (data.runId) console.log(`Run ID: ${data.runId}`);

  console.log("\nStep Results:");
  console.log("─".repeat(50));

  for (const step of data.results ?? []) {
    const icon = step.status === "ok" ? "✅" : "❌";
    const dur = step.durationMs ? ` (${step.durationMs}ms)` : "";
    console.log(`  ${icon} ${step.action}${dur}`);
    if (step.error) console.log(`     └─ Error: ${step.error}`);
    if (step.action === "monitor" && step.count !== undefined) {
      console.log(`     └─ Events received: ${step.count}`);
      if (step.eventTypes?.length) {
        console.log(`     └─ Types: ${step.eventTypes.join(", ")}`);
      }
      if (step.families?.length) {
        console.log(`     └─ Families: ${step.families.join(", ")}`);
      }
      if (step.events?.length) {
        for (const evt of step.events) {
          const payload = typeof evt.payload === "string" ? JSON.parse(evt.payload) : evt.payload;
          const type = payload?.type || evt.resourceState || "unknown";
          console.log(`        • ${type} (resource: ${evt.resourceId})`);
        }
      }
    }
  }
  console.log("\n" + "─".repeat(50));
}

async function runE2e() {
  console.log("🏥 Workspace Events E2E Health Check");
  console.log("─".repeat(50));
  console.log(`Endpoint: ${BASE}/api/gws-health-check/run-e2e`);
  console.log("Worker creates a folder, subscribes, mutates a Doc, and verifies Pub/Sub → webhook → D1.");
  console.log("Expect ~20–60 seconds.\n");

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/api/gws-health-check/run-e2e`, {
      method: "POST",
      headers: authHeaders(),
    });
  } catch (err) {
    console.error("❌ Failed to reach endpoint:", err.message);
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  printRun(data, elapsed);
  process.exit(data.status === "ok" ? 0 : 1);
}

async function main() {
  if (args.has("--configure-push")) {
    await configurePush();
  }
  if (args.has("--verify-push") || args.has("--configure-push")) {
    await verifyPush();
  }
  if (args.has("--results-only")) {
    await listResults();
    return;
  }
  if (args.has("--configure-push") && !args.has("--run") && !args.has("--verify-push")) {
    // configure-push alone still runs the e2e unless --skip-e2e is set
  }
  if (args.has("--skip-e2e")) return;
  await runE2e();
}

main();
