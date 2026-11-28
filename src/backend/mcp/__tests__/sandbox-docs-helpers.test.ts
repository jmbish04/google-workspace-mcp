import { describe, expect, it } from "vitest";

import reference from "@/backend/docs/__fixtures__/reference-resume.structure.json";
import { buildHarnessModule } from "@/backend/mcp/code-mode";
import { buildDocsHelperSource, SANDBOX_FUNCTIONS } from "@/backend/mcp/sandbox-docs-helpers";

/** Load a generated sandbox module the way the Worker Loader would, and run it once. */
async function runSnippet(code: string, toolResult: unknown = null): Promise<any> {
  const source = buildHarnessModule(code);
  const mod = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const env = { TOOLS: { callTool: async () => toolResult }, SUB: "s1" };
  const res: Response = await mod.default.fetch(new Request("https://code-mode.internal/run"), env);
  return res.json();
}

const doc = {
  revisionId: "r1",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Tab 1" },
      documentTab: {
        body: {
          content: [
            { endIndex: 1, sectionBreak: {} },
            {
              startIndex: 1,
              endIndex: 7,
              paragraph: { elements: [{ startIndex: 1, endIndex: 7, textRun: { content: "Hello\n", textStyle: {} } }], paragraphStyle: {} },
            },
          ],
        },
      },
    },
  ],
};

describe("docs helper object in code_mode_run (B4)", () => {
  it("exposes cellIndex, layout and utf16Length without imports", async () => {
    const out = await runSnippet(`
      return {
        cell: docs.cellIndex(7, 1, 3, 0, 2),
        starts: docs.layoutTables(1, [{ rows: 1, columns: 1 }, { rows: 1, columns: 3 }, { rows: 1, columns: 2 }]).map((t) => t.tableStart),
        len: docs.utf16Length("a😀"),
        after: docs.afterTable(1, 1, 1),
      };
    `);
    expect(out).toEqual({ ok: true, result: { cell: 15, starts: [2, 8, 18], len: 3, after: 7 }, logs: [] });
  });

  it("runs docs.outline and docs.find on a document read through tools", async () => {
    const out = await runSnippet(
      `
      const json = await tools.docs_get_json({ documentId: "x" });
      return { outline: docs.outline(json).tabs[0].items[1], lines: docs.outlineLines(docs.outline(json)), hits: docs.find(json, "ll") };
    `,
      doc,
    );
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.result.outline).toMatchObject({ kind: "paragraph", start: 1, end: 7, text: "Hello" });
    expect(out.result.lines.at(-1)).toBe("END t.0 7");
    expect(out.result.hits).toEqual([{ tabId: "t.0", startIndex: 3, endIndex: 5, text: "ll", bold: false, inSuggestion: false }]);
  });

  it("computes final cell starts the same way as the host", async () => {
    const lens = (reference.body as any[])
      .filter((el) => "table" in el)
      .flatMap((t) => t.cells.flat().map((c: any) => c.end - c.start - 2));
    const out = await runSnippet(`
      const cells = docs.layoutTables(1, [{ rows: 1, columns: 1 }, { rows: 1, columns: 3 }, { rows: 1, columns: 2 }]).flatMap((t) => t.cells);
      return docs.finalCellStarts(cells, ${JSON.stringify(lens)});
    `);
    expect(out.result).toEqual([5, 157, 204, 237, 277, 770]);
  });

  it("is frozen, so a snippet cannot replace a helper", async () => {
    const out = await runSnippet(`"use strict"; try { docs.cellIndex = () => 0; return "changed"; } catch { return "frozen"; }`);
    expect(out.result).toBe("frozen");
  });

  it("generates source that references only functions it declares", () => {
    const src = buildDocsHelperSource();
    expect(src).toContain("const docs = Object.freeze(");
    expect(src).not.toMatch(/\bimport\b/);
  });

  it("keeps every helper free of nested named functions and module references (SANDBOX RULE)", () => {
    const offenders = SANDBOX_FUNCTIONS.filter((fn) => {
      const src = fn.toString();
      return (
        src.match(/\bfunction\b/g)?.length !== 1 ||
        /\b(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/.test(src) ||
        /__vite_ssr_import|__vi_import/.test(src)
      );
    }).map((fn) => fn.name);
    expect(offenders).toEqual([]);
  });
});
