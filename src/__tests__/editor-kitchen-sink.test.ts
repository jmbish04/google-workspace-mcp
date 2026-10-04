/**
 * @fileoverview Tests for Phase 2 Rich Text Editor Kitchen-Sink route & components.
 *
 * Verifies non-negotiable architectural requirements:
 * 1. Astro island mount must strictly use `client:only="react"` (NEVER `client:load`
 *    which causes SSR null-dispatcher useMemo crashes with Tiptap/Yjs).
 * 2. Nav entry exists in `src/frontend/lib/config.ts`.
 * 3. RTE-4 graceful degradation via `openStandaloneRoom` (empty presence, local editing)
 *    and documented Phase 3 live Yjs wire-point (Task aaff4cf37733).
 * 4. RTE-5 deterministic stub plans and documented Phase 5 wire-point (Task 67656680f6e8).
 * 5. Kitchen Sink island exports and mounts all five rich-text-editor blocks plus sheet-10.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openStandaloneRoom } from "@/components/blocks/rich-text-editor-4/components/peer-script";
import { siteConfig } from "@/frontend/lib/config";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strip comments to check template markup only */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Phase 2 Editor Kitchen-Sink Route & Mounting Rules", () => {
  it("enforces client:only='react' and forbids client:load on /gws/editor-kitchen-sink.astro", () => {
    const raw = read("src/frontend/pages/gws/editor-kitchen-sink.astro");
    const markup = stripComments(raw);

    // Must import EditorKitchenSink
    expect(raw).toMatch(/import\s*\{\s*EditorKitchenSink\s*\}\s*from/);

    // Hard Rule: client:only="react" MUST be present
    expect(markup).toMatch(/<EditorKitchenSink\s+client:only="react"\s*\/>/);

    // Forbid client:load (would cause SSR null-dispatcher useMemo crash)
    expect(markup).not.toMatch(/client:load/);
  });

  it("enforces client:only='react' and forbids client:load on /showcase/editors.astro", () => {
    const raw = read("src/frontend/pages/showcase/editors.astro");
    const markup = stripComments(raw);

    // Must import EditorKitchenSink
    expect(raw).toMatch(/import\s*\{\s*EditorKitchenSink\s*\}\s*from/);

    // Hard Rule: client:only="react" MUST be present
    expect(markup).toMatch(/<EditorKitchenSink\s+client:only="react"\s*\/>/);

    // Forbid client:load
    expect(markup).not.toMatch(/client:load/);
  });

  it("includes /gws/editor-kitchen-sink in frontend siteConfig navigation", () => {
    const allItems = [
      ...siteConfig.navItems,
      ...siteConfig.navGroups.flatMap((group) => group.items),
    ];
    const entry = allItems.find((item) => item.href === "/gws/editor-kitchen-sink");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Editor Kitchen Sink");
  });
});

describe("Phase 2 Block Graceful Degradation & Wire-Points", () => {
  it("provides RTE-4 standalone room with 0 foreign peers for graceful degradation", () => {
    const { room, close } = openStandaloneRoom(1);
    try {
      expect(room).toBeDefined();
      expect(room.local.doc).toBeDefined();
      expect(room.local.awareness).toBeDefined();

      // In standalone mode, only the local client (or 0 foreign peers) is present in awareness
      const states = room.local.awareness.getStates();
      expect(states.size).toBeLessThanOrEqual(1);

      // Presence store initially shows empty/offline teammates
      const initialPresence = room.presence.getSnapshot();
      expect(initialPresence.length).toBe(0);
    } finally {
      close();
    }
  });

  it("documents RTE-4 Phase 3 live Yjs collaboration wire-point (Task aaff4cf37733)", () => {
    const peerScriptSrc = read(
      "src/components/blocks/rich-text-editor-4/components/peer-script.ts",
    );
    const editorSrc = read(
      "src/components/blocks/rich-text-editor-4/components/live-spec-editor.tsx",
    );

    expect(peerScriptSrc).toContain("Phase 3 - Task aaff4cf37733");
    expect(editorSrc).toContain("Phase 3 - Task aaff4cf37733");
  });

  it("documents RTE-5 Phase 5 Core Guardian live model backend wire-point (Task 67656680f6e8)", () => {
    const assistPlansSrc = read(
      "src/components/blocks/rich-text-editor-5/components/assist-plans.ts",
    );
    expect(assistPlansSrc).toContain("Phase 5 - Task 67656680f6e8");
  });

  it("kitchen sink island integrates all five editor blocks and sheet-10", () => {
    const sinkSrc = read("src/frontend/components/editor-kitchen-sink/EditorKitchenSink.tsx");

    // All five RTE blocks + sheet-10 must be imported
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/rich-text-editor-1\/components\/rich-text-editor["']/,
    );
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/rich-text-editor-2\/components\/page-editor["']/,
    );
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/rich-text-editor-3\/components\/contract-editor["']/,
    );
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/rich-text-editor-4\/components\/live-spec-editor["']/,
    );
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/rich-text-editor-5\/components\/doc-assistant["']/,
    );
    expect(sinkSrc).toMatch(
      /from\s*["']@\/components\/blocks\/sheet-10\/components\/ask-reui-sheet["']/,
    );

    // Feature tabs and UI indicators
    expect(sinkSrc).toContain("rte-1");
    expect(sinkSrc).toContain("rte-2");
    expect(sinkSrc).toContain("rte-3");
    expect(sinkSrc).toContain("rte-4");
    expect(sinkSrc).toContain("rte-5");
    expect(sinkSrc).toContain("sheet-10");
  });
});
