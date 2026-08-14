import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dispatch chokepoint + its side-effects so these tests exercise the
// ROUTER (schema validation, 404/400 handling, sub resolution, logging) without
// touching Google or the DB.
const runTool = vi.fn(async () => ({ result: { ok: true }, asset: { assetType: "drive", googleId: "g1", action: "create" as const } }));
vi.mock("@/backend/mcp/tool-runner", () => ({ runTool: (...a: unknown[]) => runTool(...(a as [])) }));

const logOperation = vi.fn(async () => {});
const logAssetTouch = vi.fn(async () => {});
vi.mock("@/backend/mcp/logging", () => ({ logOperation: (...a: unknown[]) => logOperation(...(a as [])), logAssetTouch: (...a: unknown[]) => logAssetTouch(...(a as [])) }));

let accounts: { email: string; ref: string }[] = [];
vi.mock("@/backend/gmail/sync-service", () => ({ listCaptureAccounts: vi.fn(async () => accounts) }));

import { toolsRouter } from "../tools";

const env: any = {};

beforeEach(() => {
  runTool.mockClear();
  logOperation.mockClear();
  logAssetTouch.mockClear();
  accounts = [{ email: "a@x.com", ref: "sub-a" }];
});

describe("GET /api/tools", () => {
  it("lists callable tools with schemas and excludes code_mode meta-tools", async () => {
    const res = await toolsRouter.request("/", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string; inputSchema: unknown }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("drive_upload_file");
    expect(names).toContain("search_files");
    expect(names.some((n) => n.startsWith("code_mode"))).toBe(false);
    expect(body.tools[0].inputSchema).toBeTruthy();
  });
});

describe("GET /api/tools/:name", () => {
  it("returns one tool's schema", async () => {
    const res = await toolsRouter.request("/drive_create_folder", {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("drive_create_folder");
  });
  it("404s an unknown tool", async () => {
    const res = await toolsRouter.request("/nope", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tools/:name", () => {
  it("404s an unknown tool", async () => {
    const res = await toolsRouter.request("/nope", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, env);
    expect(res.status).toBe(404);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("400s on invalid arguments (schema violation)", async () => {
    // drive_create_folder requires `name: string`; omit it.
    const res = await toolsRouter.request(
      "/drive_create_folder",
      { method: "POST", body: JSON.stringify({ parentId: "p1" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid arguments");
    expect(runTool).not.toHaveBeenCalled();
  });

  it("dispatches valid args through runTool and logs the operation + asset", async () => {
    const res = await toolsRouter.request(
      "/drive_create_folder",
      { method: "POST", body: JSON.stringify({ name: "Reports" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true } });

    expect(runTool).toHaveBeenCalledTimes(1);
    const [, ctx, args] = runTool.mock.calls[0] as any[];
    expect(args).toMatchObject({ name: "Reports" });
    expect(ctx.sub).toBe("sub-a"); // no as_user → first active account
    expect(logOperation).toHaveBeenCalledWith(env, expect.objectContaining({ toolName: "drive_create_folder", success: true }));
    expect(logAssetTouch).toHaveBeenCalledWith(env, expect.objectContaining({ userSub: "sub-a", googleId: "g1" }));
  });

  it("uses as_user for the sub sentinel when provided", async () => {
    const res = await toolsRouter.request(
      "/drive_create_folder",
      { method: "POST", body: JSON.stringify({ name: "Reports", as_user: "b@x.com" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
    const [, ctx] = runTool.mock.calls[0] as any[];
    expect(ctx.sub).toBe("api:b@x.com"); // as_user present → sentinel; acct() inside the tool uses the email
  });

  it("errors clearly when no account is signed in and no as_user given", async () => {
    accounts = [];
    const res = await toolsRouter.request(
      "/drive_create_folder",
      { method: "POST", body: JSON.stringify({ name: "Reports" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(runTool).not.toHaveBeenCalled();
  });
});
