import { describe, it, expect } from "vitest";

import { mergeAppsScriptFiles, hasManifest, type AppsScriptFile } from "../merge-files";

const f = (name: string, source: string, type: AppsScriptFile["type"] = "SERVER_JS"): AppsScriptFile => ({
  name,
  type,
  source,
});

const manifest = f("appsscript", "{}", "JSON");

describe("mergeAppsScriptFiles", () => {
  it("preserves existing files (incl. manifest) when adding a new file", () => {
    const merged = mergeAppsScriptFiles([manifest, f("Code", "old")], [f("Helper", "new")]);
    expect(merged.map((m) => m.name)).toEqual(["appsscript", "Code", "Helper"]);
    expect(hasManifest(merged)).toBe(true);
  });

  it("overlays a same-named file in place (no duplicate, keeps order)", () => {
    const merged = mergeAppsScriptFiles([manifest, f("Code", "old"), f("Util", "u")], [f("Code", "new")]);
    expect(merged.map((m) => m.name)).toEqual(["appsscript", "Code", "Util"]);
    expect(merged.find((m) => m.name === "Code")?.source).toBe("new");
  });

  it("does not drop the manifest when it isn't in the incoming set", () => {
    const merged = mergeAppsScriptFiles([manifest, f("Code", "x")], [f("A", "a"), f("B", "b", "HTML")]);
    expect(hasManifest(merged)).toBe(true);
    expect(merged).toHaveLength(4);
  });

  it("lets an explicit manifest override replace it", () => {
    const merged = mergeAppsScriptFiles([manifest], [f("appsscript", '{"runtimeVersion":"V8"}', "JSON")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toContain("V8");
  });

  it("appends brand-new files after existing ones", () => {
    const merged = mergeAppsScriptFiles([f("Code", "x")], [f("Zeta", "z"), f("Alpha", "a")]);
    expect(merged.map((m) => m.name)).toEqual(["Code", "Zeta", "Alpha"]);
  });
});
