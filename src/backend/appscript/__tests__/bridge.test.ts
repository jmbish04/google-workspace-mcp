import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveGasScript = vi.fn<(...a: unknown[]) => Promise<unknown>>();
const run = vi.fn<(...a: unknown[]) => Promise<unknown>>();

vi.mock("@/backend/appscript/gas-projects", () => ({ resolveGasScript: (...a: unknown[]) => resolveGasScript(...a) }));
vi.mock("@/backend/mcp/services/appsscript", () => ({
  AppsScriptService: class {
    run = run;
  },
}));

import { runBridgeAction } from "../bridge";

const env = {} as Env;

beforeEach(() => {
  resolveGasScript.mockReset();
  run.mockReset();
  resolveGasScript.mockResolvedValue({ scriptId: "S1", entry: "runBridge" });
});

describe("runBridgeAction", () => {
  it("runs runBridge(action, params) on the deployed build and returns result", async () => {
    run.mockResolvedValue({ response: { result: { ok: true, action: "health", result: { ok: true, version: 1 } } } });
    await expect(runBridgeAction(env, "ref", "Justin@126Colby.com", "health", { a: 1 })).resolves.toEqual({ ok: true, version: 1 });
    expect(resolveGasScript).toHaveBeenCalledWith(env, "workspace-bridge", "justin@126colby.com");
    expect(run).toHaveBeenCalledWith("S1", "runBridge", ["health", { a: 1 }], false);
  });

  it("unregistered account → actionable error naming set_gas_script, and never calls scripts.run", async () => {
    resolveGasScript.mockResolvedValue(undefined);
    await expect(runBridgeAction(env, "ref", "x@y.com", "health", {})).rejects.toThrow(/not registered for x@y.com.*set_gas_script/);
    expect(run).not.toHaveBeenCalled();
  });

  it("script returned ok:false → throws with the bridge's code and message", async () => {
    run.mockResolvedValue({ response: { result: { ok: false, code: "bad_params", error: '"html" is required' } } });
    await expect(runBridgeAction(env, "ref", "a@b.com", "gmail.createDraft", {})).rejects.toThrow(
      'workspace-bridge gmail.createDraft: bad_params: "html" is required',
    );
  });

  it("scripts.run error (script threw / not authorized) → throws with Google's details", async () => {
    run.mockResolvedValue({ error: { details: [{ errorMessage: "Authorization is required" }] } });
    await expect(runBridgeAction(env, "ref", "a@b.com", "health", {})).rejects.toThrow(/Authorization is required/);
  });

  it("no envelope at all → explains the two likely causes instead of returning undefined", async () => {
    run.mockResolvedValue({ response: {} });
    await expect(runBridgeAction(env, "ref", "a@b.com", "health", {})).rejects.toThrow(/API Executable.*authorized/);
  });
});
