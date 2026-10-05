/**
 * `suggestDraftRevision` — the Core Guardian revision suggestion. Guardian and
 * the D1 draft load are mocked; the compose step (renderStudioBody) stays real
 * so the returned preview is the actual Gmail-ready bytes acceptance would store.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { guardianRun, getStudioDraft } = vi.hoisted(() => ({ guardianRun: vi.fn(), getStudioDraft: vi.fn() }));

vi.mock("@/backend/lib/guardian-ai", async (importActual) => {
  const actual = await importActual<typeof import("@/backend/lib/guardian-ai")>();
  return { ...actual, guardianRun };
});

vi.mock("@/backend/gmail/draft-studio", async (importActual) => {
  const actual = await importActual<typeof import("@/backend/gmail/draft-studio")>();
  return { ...actual, getStudioDraft }; // renderStudioBody stays real
});

// Secrets: no overrides configured → defaults are used.
vi.mock("@/backend/utils/secrets", () => ({ getSecret: vi.fn(async () => undefined) }));

import { suggestDraftRevision } from "../draft-suggest";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const env = {} as Env;

function draft(over: Record<string, unknown> = {}) {
  return {
    id: "d1", status: "drafting", uuid: UUID,
    current: { id: "r1", n: 1, html: "<p>old body</p>", text: "old body", source: "agent", note: null, createdAt: new Date() },
    revisions: [], comments: [],
    ...over,
  };
}

beforeEach(() => {
  guardianRun.mockReset();
  getStudioDraft.mockReset();
});

describe("suggestDraftRevision", () => {
  it("strips a code fence from the model output and composes a real preview", async () => {
    getStudioDraft.mockResolvedValue(draft());
    guardianRun.mockResolvedValue({ body: { choices: [{ message: { content: "```markdown\nHello **Bob**, the revised line.\n```" } }] } });

    const out = await suggestDraftRevision(env, "d1", "tighten it");

    expect(out.suggestedMarkdown).toBe("Hello **Bob**, the revised line.");
    expect(out.suggestedMarkdown).not.toContain("```");
    expect(out.originalText).toBe("old body");
    // Compose ran for real: HTML carries the bold run, text is the readable body.
    expect(out.suggestedHtml).toMatch(/<strong[^>]*>Bob<\/strong>/);
    expect(out.suggestedText).toContain("Bob");
  });

  it("throws when Guardian is unreachable (returns null) — never a silent half-suggestion", async () => {
    getStudioDraft.mockResolvedValue(draft());
    guardianRun.mockResolvedValue(null);
    await expect(suggestDraftRevision(env, "d1", "x")).rejects.toThrow(/unavailable/i);
  });

  it("throws when the draft is already sent", async () => {
    getStudioDraft.mockResolvedValue(draft({ status: "sent" }));
    await expect(suggestDraftRevision(env, "d1", "x")).rejects.toThrow(/sent/i);
  });
});
