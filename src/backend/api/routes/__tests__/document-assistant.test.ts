/**
 * @fileoverview Unit tests for the Document Assistant API route.
 *
 * Verifies:
 * 1. Health check endpoint reports model gateway routing to Core Guardian.
 * 2. Document-aware suggestion chips differ when text is selected vs document-level.
 * 3. Selection-scoped actions produce suggestions ANCHORED to the selection range.
 * 4. Step trace is generated detailing the assistant's actions.
 * 5. Tracked suggestion output is produced (never silent overwrite).
 * 6. Model calls route through Core Guardian with graceful degradation fallback.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import * as guardianModule from "@/backend/lib/guardian-ai";

import { documentAssistantRouter } from "../document-assistant";

const testEnv = {
  WORKER_API_KEY: "test-key",
  AI_GATEWAY_TOKEN: "test-gateway-token",
} as any;

describe("Document Assistant API — /api/document-assistant", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/document-assistant/health reports healthy status and Core Guardian gateway", async () => {
    const res = await documentAssistantRouter.request("/health", {}, testEnv);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toMatchObject({
      status: "healthy",
      service: "document-assistant",
      model_gateway: "core-guardian",
      wire_point_phase5: "Task 67656680f6e8",
    });
  });

  it("GET /api/document-assistant/suggestions returns document-level chips when hasSelection is false", async () => {
    const res = await documentAssistantRouter.request(
      "/suggestions?hasSelection=false",
      {},
      testEnv,
    );
    expect(res.status).toBe(200);

    const { chips } = (await res.json()) as any;
    expect(Array.isArray(chips)).toBe(true);
    expect(chips.length).toBeGreaterThanOrEqual(4);

    const labels = chips.map((c: any) => c.label);
    expect(labels).toContain("Draft executive summary");
    expect(labels).toContain("Tighten wordy sections");
    expect(labels).toContain("Extract launch checklist");
    expect(chips.every((c: any) => c.category === "document")).toBe(true);
  });

  it("GET /api/document-assistant/suggestions returns selection-scoped chips when hasSelection is true", async () => {
    const res = await documentAssistantRouter.request(
      "/suggestions?hasSelection=true",
      {},
      testEnv,
    );
    expect(res.status).toBe(200);

    const { chips } = (await res.json()) as any;
    expect(Array.isArray(chips)).toBe(true);
    expect(chips.length).toBeGreaterThanOrEqual(4);

    const labels = chips.map((c: any) => c.label);
    expect(labels).toContain("Tighten this paragraph");
    expect(labels).toContain("Make the tone firmer");
    expect(labels).toContain("Turn this into a bulleted list");
    expect(labels).toContain("Proofread selection");
    expect(chips.every((c: any) => c.category === "selection")).toBe(true);
  });

  it("POST /api/document-assistant/act anchors selection-scoped 'make tone firmer' suggestions", async () => {
    const selectedText =
      "We might want to consider deploying the service next week if things look ok.";
    const documentText = `Launch Plan\n\n${selectedText}\n\nRisks and Mitigations`;
    const fromPos = 13;
    const toPos = 13 + selectedText.length;

    const res = await documentAssistantRouter.request(
      "/act",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Make the tone firmer",
          documentText,
          selectedText,
          scope: { from: fromPos, to: toPos },
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Must return step trace
    expect(Array.isArray(data.trace)).toBe(true);
    expect(data.trace.length).toBeGreaterThan(0);
    expect(data.trace.some((step: string) => /read|selection/i.test(step))).toBe(true);

    // Must return tracked suggestions anchored to the selection range
    expect(Array.isArray(data.suggestions)).toBe(true);
    expect(data.suggestions.length).toBe(1);

    const suggestion = data.suggestions[0];
    expect(suggestion.kind).toBe("replace");
    expect(suggestion.find).toBe(selectedText);
    expect(suggestion.at).toBe(fromPos);
    expect(suggestion.text).not.toBe(selectedText);
    expect(suggestion.text).toMatch(/we will/i);

    // Must include Phase 5 wire-point header
    expect(res.headers.get("x-wire-point-phase5")).toContain("Task 67656680f6e8");
  });

  it("POST /api/document-assistant/act converts selection into a bulleted list with step trace", async () => {
    const selectedText =
      "First complete database migration. Then update API endpoints. Finally deploy web client.";
    const fromPos = 50;

    const res = await documentAssistantRouter.request(
      "/act",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "turn this into a bulleted list",
          documentText: `Header\n${selectedText}\nFooter`,
          selectedText,
          scope: { from: fromPos, to: fromPos + selectedText.length },
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Verify step trace
    expect(data.trace.length).toBeGreaterThanOrEqual(2);
    expect(data.trace.some((s: string) => /bullet/i.test(s))).toBe(true);

    // Verify anchored suggestion
    const edit = data.suggestions[0];
    expect(edit.kind).toBe("replace");
    expect(edit.find).toBe(selectedText);
    expect(edit.at).toBe(fromPos);
    expect(edit.text).toContain("• First complete database migration");
    expect(edit.text).toContain("• Then update API endpoints");
  });

  it("POST /api/document-assistant/act routes through Core Guardian when available", async () => {
    const guardianSpy = vi.spyOn(guardianModule, "guardianRun").mockResolvedValue({
      request_uuid: "req-123",
      status: 200,
      provider: "google",
      model: "gemini-2.5-flash",
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "Rewritten through Core Guardian.",
                trace: ["Analyzed via Core Guardian", "Tightened phrasing", "Staged suggestion"],
                summary: { title: "Guardian Tightened", detail: "4 words cut" },
                rewrittenText: "Deploy service next week.",
              }),
            },
          },
        ],
      },
    });

    const res = await documentAssistantRouter.request(
      "/act",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "tighten this paragraph",
          documentText: "We will deploy the service next week.",
          selectedText: "We will deploy the service next week.",
          scope: { from: 0, to: 36 },
        }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    expect(guardianSpy).toHaveBeenCalledTimes(1);

    const data = (await res.json()) as any;
    expect(data.mode).toBe("guardian");
    expect(data.reply).toBe("Rewritten through Core Guardian.");
    expect(data.suggestions[0].text).toBe("Deploy service next week.");
    expect(data.trace).toContain("Analyzed via Core Guardian");
  });
});
