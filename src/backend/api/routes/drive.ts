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
import { GoogleApiError } from "@/backend/mcp/googleClient";
import { extractGoogleId } from "@/backend/google/core/ids";

import { resolveActingRef } from "../lib/acting-account";
import type { AppBindings } from "../index";

export const driveRouter = new OpenAPIHono<AppBindings>();

/** Simple `uploadType=media` buffers the whole body in memory — cap it. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** A form field's value only when it's a non-empty string (multipart parts can be Files). */
function formStr(v: FormDataEntryValue | null): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

const errorBody = z.object({ error: z.string() });

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
      400: { description: "Missing file / unknown as_user", content: { "application/json": { schema: errorBody } } },
      413: { description: "File too large", content: { "application/json": { schema: errorBody } } },
      502: { description: "Upstream Google API error", content: { "application/json": { schema: errorBody } } },
    },
  }),
  async (c) => {
    // Use Hono's cached formData() (not c.req.raw.formData()) — the OpenAPI
    // multipart request-body validator may have already consumed the raw body.
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "Missing `file` (multipart/form-data)." }, 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: `File too large (${file.size} bytes); max ${MAX_UPLOAD_BYTES}.` }, 413);
    }

    const asUser = formStr(form.get("as_user"));
    const folderIdIn = formStr(form.get("folderId"));
    const folderPath = formStr(form.get("folderPath"));
    const name = formStr(form.get("name")) ?? file.name ?? "upload";
    const mimeType = file.type || "application/octet-stream";

    try {
      const drive = new DriveService(c.env, await resolveActingRef(c.env, asUser));
      // Accept a pasted Drive folder URL as well as a bare id (AGENTS rule 18).
      const folderId = folderIdIn
        ? extractGoogleId(folderIdIn)
        : folderPath
          ? await drive.resolveFolderPath(folderPath)
          : undefined;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const f = await drive.uploadBinary(name, mimeType, bytes, folderId);
      const driveUrl = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
      return c.json({ driveId: f.id, driveUrl, name: f.name, mimeType, folderId: folderId ?? null }, 200);
    } catch (err) {
      // Never mirror an upstream Google status/body onto our response.
      if (err instanceof GoogleApiError) return c.json({ error: `Upstream Google API error (${err.status}).` }, 502);
      throw err;
    }
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
      400: { description: "Unknown as_user", content: { "application/json": { schema: errorBody } } },
      502: { description: "Upstream Google API error", content: { "application/json": { schema: errorBody } } },
    },
  }),
  async (c) => {
    const { folderPath, as_user } = c.req.valid("json");
    try {
      const drive = new DriveService(c.env, await resolveActingRef(c.env, as_user));
      const folderId = await drive.resolveFolderPath(folderPath);
      return c.json({ folderId, folderUrl: `https://drive.google.com/drive/folders/${folderId}` }, 200);
    } catch (err) {
      if (err instanceof GoogleApiError) return c.json({ error: `Upstream Google API error (${err.status}).` }, 502);
      throw err;
    }
  },
);
