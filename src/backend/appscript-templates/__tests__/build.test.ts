import { describe, it, expect } from "vitest";

import { buildTemplate, type BindConfig } from "../index";

/** A representative proposal-followup config. */
const config: BindConfig = {
  title: "Proposal Follow-ups",
  questions: {
    title: "A few questions",
    outputTitle: "Client Answers",
    fields: [
      {
        id: "budget",
        label: "Budget tier",
        type: "single",
        options: ["Low", "High"],
      },
      {
        id: "features",
        label: "Wanted features",
        type: "multi",
        options: ["A", "B"],
      },
      { id: "notes", label: "Anything else?", type: "textarea" },
    ],
  },
};

/** Find a file by name in a built template. */
function file_(
  files: { name: string; source: string }[],
  name: string
): string {
  const f = files.find((x) => x.name === name);
  if (!f) throw new Error(`missing file ${name}`);
  return f.source;
}

describe("buildTemplate", () => {
  it("agent-questions injects the config and bakes in the Docs advanced service", () => {
    const files = buildTemplate("agent-questions", config);
    const names = files.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "appsscript",
        "Config",
        "Menu",
        "Host",
        "Questions",
        "Sidebar",
      ])
    );

    // Config is embedded verbatim so the sidebar can render it at runtime.
    const cfg = file_(files, "Config");
    expect(cfg).toContain('"outputTitle": "Client Answers"');
    expect(cfg).toContain('"type": "multi"');

    // Manifest declares the Docs advanced service used to create Doc tabs.
    const manifest = JSON.parse(file_(files, "appsscript"));
    expect(manifest.dependencies.enabledAdvancedServices[0].serviceId).toBe(
      "docs"
    );
    expect(manifest.oauthScopes).toContain(
      "https://www.googleapis.com/auth/documents"
    );
  });

  it("agent-questions defaults a menu that opens the sidebar when none is given", () => {
    const cfg = JSON.parse(
      file_(buildTemplate("agent-questions", config), "Config")
        .replace(/^[\s\S]*?AGENT_CONFIG = /, "")
        .replace(/;[\s\S]*$/, "")
    );
    expect(cfg.menu.items[0].fn).toBe("showQuestions");
  });

  it("Host routes output by host type (doc tab / sheet tab / slide appendix)", () => {
    const host = file_(buildTemplate("agent-questions", config), "Host");
    expect(host).toContain("addDocumentTab");
    expect(host).toContain("insertSheet");
    expect(host).toContain("appendSlide");
  });

  it("webapp includes doGet and only adds a menu when configured", () => {
    const bare = buildTemplate("webapp", { title: "Site" }).map((f) => f.name);
    expect(bare).toContain("WebApp");
    expect(bare).not.toContain("Menu");

    const withMenu = buildTemplate("webapp", {
      title: "Site",
      menu: { items: [{ label: "Home", fn: "doGet" }] },
    }).map((f) => f.name);
    expect(withMenu).toContain("Menu");
  });

  it("legacy static templates still resolve", () => {
    expect(buildTemplate("sidebar", { title: "x" }).length).toBeGreaterThan(0);
  });

  it("rejects unknown templates", () => {
    expect(() => buildTemplate("nope", { title: "x" })).toThrow(
      /Unknown Apps Script template/
    );
  });
});
