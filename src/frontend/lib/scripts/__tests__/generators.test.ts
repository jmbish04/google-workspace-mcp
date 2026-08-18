import { describe, it, expect } from "vitest";

import { buildBody, generateSnippets } from "../generators";
import type { ScriptSpec } from "../types";

const spec: ScriptSpec = {
  slug: "demo",
  title: "Demo",
  summary: "demo",
  tag: "Drive",
  emoji: "📁",
  tool: "drive_folder_tree",
  params: [
    { name: "folderId", label: "Folder", required: true },
    { name: "maxNodes", label: "Max", type: "number", default: "2000" },
    { name: "as_user", label: "As", default: "" },
  ],
};

describe("buildBody", () => {
  it("coerces numbers and drops empty values", () => {
    const body = buildBody(spec, { folderId: "abc", maxNodes: "500", as_user: "" });
    expect(body).toEqual({ folderId: "abc", maxNodes: 500 });
  });

  it("falls back to param defaults", () => {
    const body = buildBody(spec, { folderId: "abc" });
    expect(body.maxNodes).toBe(2000);
  });
});

describe("generateSnippets", () => {
  const snips = generateSnippets(spec, { folderId: "abc" }, "https://gws.example.com/");
  const byId = Object.fromEntries(snips.map((s) => [s.id, s]));

  it("emits four language tabs", () => {
    expect(snips.map((s) => s.id)).toEqual(["curl", "python", "typescript", "appsscript"]);
  });

  it("targets the REST bridge endpoint with the tool name", () => {
    expect(byId.curl.files[0].code).toContain("/api/tools/drive_folder_tree");
    expect(byId.curl.files[0].code).not.toContain("//api/tools"); // trailing slash trimmed
  });

  it("references the token via env, never embeds it", () => {
    expect(byId.python.files[0].code).toContain('os.environ["WORKER_API_KEY"]');
    expect(byId.typescript.files[0].code).toContain("process.env.WORKER_API_KEY");
  });

  it("apps script tab ships Code.gs + appsscript.json manifest with the urlfetch scope", () => {
    const files = byId.appsscript.files;
    expect(files.map((f) => f.filename)).toEqual(["Code.gs", "appsscript.json"]);
    expect(files[0].code).toContain("UrlFetchApp.fetch");
    expect(files[1].code).toContain("script.external_request");
  });
});

describe("generateSnippets with an output path", () => {
  const snips = generateSnippets(spec, { folderId: "abc" }, "https://gws.example.com", {
    outputPath: "~/Downloads/report.json",
  });
  const byId = Object.fromEntries(snips.map((s) => [s.id, s]));

  it("adds curl -o with the path", () => {
    expect(byId.curl.files[0].code).toContain("-o '~/Downloads/report.json'");
  });

  it("writes the file in Python and TypeScript", () => {
    expect(byId.python.files[0].code).toContain("json.dump(result, f");
    expect(byId.python.files[0].code).toContain("os.path.expanduser");
    expect(byId.typescript.files[0].code).toContain("writeFile(outPath");
  });

  it("omits the file write when no path is given", () => {
    const plain = generateSnippets(spec, { folderId: "abc" }, "https://gws.example.com");
    expect(plain.find((s) => s.id === "curl")!.files[0].code).not.toContain("-o ");
    expect(plain.find((s) => s.id === "python")!.files[0].code).toContain("print(json.dumps");
  });
});
