/**
 * @fileoverview `/api/drive/*` — first-class REST Drive endpoints for the most
 * common workflow: upload a document into an organized folder and get its Drive
 * id + shareable URL back. This is the idiomatic HTTP path (multipart file
 * upload) that complements the generic `/api/tools/drive_upload_file` bridge
 * (base64 JSON).
 *
 * Routes (gated by `agentAuthMiddleware` in `api/index.ts` — the browser
 * `gsuite_session` cookie OR `Authorization: Bearer <WORKER_API_KEY>`):
 *   POST /api/drive/upload   — multipart/form-data file → `{ driveId, driveUrl, … }`
 *   POST /api/drive/folders  — resolve/create a `/`-separated folder path
 *
 * `as_user` selects a signed-in account by email (omit for the first active
 * account). Every account is a regular OAuth account — no domain-wide delegation.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { DriveService } from "@/backend/mcp/services/drive";
import { acct } from "@/backend/mcp/tools";
import { listCaptureAccounts } from "@/backend/gmail/sync-service";

import type { AppBindings } from "../index";

export const driveRouter = new OpenAPIHono<AppBindings>();

/** Acting Drive account ref: `dwd:email` for an explicit `as_user`, else the first active account. */
async function actingRef(env: Env, asUser?: string): Promise<string> {
  if (asUser) return acct("", { as_user: asUser });
  const accounts = await listCaptureAccounts(env);
  if (!accounts.length) {
    throw new Error("No signed-in Google account. Sign in at /api/auth/google/oauth/start, or pass `as_user`.");
  }
  return accounts[0].ref;
}

const uploadResult = z.object({
  driveId: z.string(),
  driveUrl: z.string(),
  name: z.string(),
  mimeType: z.string(),
  folderId: z.string().nullable(),
});

driveRouter.openapi(
  createRoute({
    method: "post",
    path: "/upload",
    tags: ["Drive"],
    summary: "Upload a document to an organized Drive folder",
    description:
      "Upload a file (multipart/form-data) into Drive and get back its id + shareable webViewLink. Target the folder by `folderId`, or by `folderPath` (a '/'-separated path like 'Clients/Acme/2026' whose folders are auto-created); omit both to land in My Drive root.",
    operationId: "driveUpload",
    request: {
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.any().openapi({ type: "string", format: "binary" }),
              folderId: z.string().optional(),
              folderPath: z.string().optional(),
              name: z.string().optional().describe("Override the stored file name (defaults to the uploaded file's name)."),
              as_user: z.string().email().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Uploaded", content: { "application/json": { schema: uploadResult } } },
      400: { description: "Missing file", content: { "application/json": { schema: z.object({ error: z.string() }) } } },
    },
  }),
  async (c) => {
    // Use Hono's cached formData() (not c.req.raw.formData()) — the OpenAPI
    // multipart request-body validator may have already consumed the raw body.
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing `file` (multipart/form-data)." }, 400);

    const asUser = (form.get("as_user") as string) || undefined;
    const folderIdIn = (form.get("folderId") as string) || undefined;
    const folderPath = (form.get("folderPath") as string) || undefined;
    const name = ((form.get("name") as string) || file.name || "upload").toString();
    const mimeType = file.type || "application/octet-stream";

    const drive = new DriveService(c.env, await actingRef(c.env, asUser));
    const folderId = folderIdIn ?? (folderPath ? await drive.resolveFolderPath(folderPath) : undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const f = await drive.uploadBinary(name, mimeType, bytes, folderId);
    const driveUrl = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;

    return c.json({ driveId: f.id, driveUrl, name: f.name, mimeType, folderId: folderId ?? null }, 200);
  },
);

driveRouter.openapi(
  createRoute({
    method: "post",
    path: "/folders",
    tags: ["Drive"],
    summary: "Resolve or create a '/'-separated Drive folder path",
    description: "Find-or-create every segment of a '/'-separated folder path and return the deepest folder's id + URL.",
    operationId: "driveResolveFolder",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ folderPath: z.string(), as_user: z.string().email().optional() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Folder resolved",
        content: { "application/json": { schema: z.object({ folderId: z.string(), folderUrl: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const { folderPath, as_user } = c.req.valid("json");
    const drive = new DriveService(c.env, await actingRef(c.env, as_user));
    const folderId = await drive.resolveFolderPath(folderPath);
    return c.json({ folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}` }, 200);
  },
);
