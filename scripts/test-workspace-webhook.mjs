/**
 * Quick smoke test for the workspace webhook endpoint.
 * Sends a mock Pub/Sub push payload and verifies auth works.
 *
 * Usage: node scripts/test-workspace-webhook.mjs
 */
import { getWorkerApiKey } from './tokens.mjs';

const workerKey = getWorkerApiKey();
const endpoint = "https://google-workspace-mcp.hacolby.workers.dev/api/webhooks/workspace";

async function runTest() {
  console.log("🔒 Workspace Webhook Auth Smoke Test");
  console.log("─".repeat(50));

  const cloudEvent = {
    specversion: "1.0",
    type: "google.workspace.drive.file.v1.contentChanged",
    source: "//drive.googleapis.com/events",
    id: `smoke-test-${Date.now()}`,
    time: new Date().toISOString(),
    subject: "files/smoke-test-file-000",
    data: { message: "smoke test" },
  };

  const payload = {
    message: {
      data: Buffer.from(JSON.stringify(cloudEvent)).toString("base64"),
      messageId: "smoke-msg-123",
    },
  };

  // Test 1: valid token
  console.log("\n1. Testing with valid token...");
  try {
    const res = await fetch(`${endpoint}?token=${workerKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`   ${res.ok ? "✅" : "❌"} Status: ${res.status}`);
  } catch (err) {
    console.error(`   ❌ Fetch failed: ${err.message}`);
  }

  // Test 2: missing token → 401
  console.log("2. Testing with missing token (expect 401)...");
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`   ${res.status === 401 ? "✅" : "❌"} Status: ${res.status}`);
  } catch (err) {
    console.error(`   ❌ Fetch failed: ${err.message}`);
  }

  // Test 3: bad token → 401
  console.log("3. Testing with bad token (expect 401)...");
  try {
    const res = await fetch(`${endpoint}?token=wrong-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`   ${res.status === 401 ? "✅" : "❌"} Status: ${res.status}`);
  } catch (err) {
    console.error(`   ❌ Fetch failed: ${err.message}`);
  }

  console.log("\n" + "─".repeat(50));
  console.log("Done.");
}

runTest();
