import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Tools run through DriveService/etc → googleFetch → global fetch, token from
// tokenProvider. Stub the token + the active-account lookup so no network/DB.
vi.mock("@/backend/mcp/tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));
vi.mock("@/backend/mcp/googleClient", async (orig) => orig());

let accounts: { email: string; ref: string }[] = [];
vi.mock("@/backend/gmail/sync-service", () => ({ listCaptureAccounts: vi.fn(async () => accounts) }));
// logging writes to D1 — no-op it.
vi.mock("@/backend/mcp/logging", () => ({ logOperation: vi.fn(async () => {}), logAssetTouch: vi.fn(async () => {}) }));

import { OpenAPIHono } from "@hono/zod-openapi";

import { toolsRouter } from "../tools";
import { errorHandler } from "../../middleware/error";

function buildApp() {
  const app = new OpenAPIHono();
  app.onError(errorHandler as never);
  app.route("/api/tools", toolsRouter);
  app.doc("/openapi.json", { openapi: "3.1.0", info: { title: "t", version: "1" } });
  return app;
}

const env: any = {};
let fetchSpy: any;
beforeEach(() => {
  accounts = [{ email: "a@x.com", ref: "sub-a" }];
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("/openapi.json tool coverage", () => {
  it("documents every callable tool as its own POST operation", async () => {
    const app = buildApp();
    const res = await app.request("/openapi.json", {}, env);
    const doc: any = await res.json();

    // The capabilities the user cares about must be discoverable + carry a body schema.
    for (const name of [
      "drive_upload_file",
      "drive_update_sharing_recursive",
      "drive_audit_sharing",
      "share_file",
      "delete_permission",
      "move_file",
      "trash_file",
      "gmail_draft_doc",
    ]) {
      const op = doc.paths?.[`/api/tools/${name}`]?.post;
      expect(op, `missing operation for ${name}`).toBeTruthy();
      expect(op.requestBody?.content?.["application/json"]?.schema, `no body schema for ${name}`).toBeTruthy();
    }
  });
});

describe("POST /api/tools/<name>", () => {
  it("runs a tool and returns { result } (account via as_user in body)", async () => {
    // trash_file → Drive files.update PATCH
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ id: "f1", name: "x", trashed: true }), { status: 200 }));
    const res = await buildApp().request(
      "/api/tools/trash_file",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: "f1", as_user: "a@x.com" }) },
      env,
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result).toMatchObject({ id: "f1", trashed: true });
  });

  it("400s when required args are missing (empty body)", async () => {
    const res = await buildApp().request("/api/tools/trash_file", { method: "POST" }, env);
    expect(res.status).toBe(400);
  });

  it("400s an unknown as_user before touching Google", async () => {
    const res = await buildApp().request(
      "/api/tools/trash_file",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileId: "f1", as_user: "nobody@x.com" }) },
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
