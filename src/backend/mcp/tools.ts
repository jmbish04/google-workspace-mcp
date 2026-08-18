/**
 * @fileoverview MCP tool catalog for the Google Workspace worker.
 *
 * Each `ToolDef.run` constructs the matching REST service and returns
 * `{ result, asset? }`. The `asset` field, when present, tells server.ts to
 * record a `workspace_assets` touch via `logAssetTouch`.
 *
 * Every tool accepts an optional `as_user` (a Workspace email). When present,
 * the call runs via Domain-Wide Delegation impersonating that user (the
 * `acct()` helper turns it into a `dwd:<email>` account ref that
 * `getAccessToken` routes to the service account). When absent, the call uses
 * the signed-in OAuth account (the default). See tokenProvider + dwd.
 *
 * Also consumed by `/api/gws/tools` for a human-facing tool list.
 */
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";

import { getDb } from "@/db";
import { templateArtifacts, driveNotifications, brailleArtifacts, gmailLabels, sheetExportJobs, docExportJobs, scheduledSends, scheduledEmails, emailPreviews, emailTemplates, type ScheduledEmailSpec } from "@db/schemas";
import { composeBody, inlineGmailStyles } from "@/backend/gmail/compose";
import { seedBuiltinTemplates } from "@/backend/gmail/email-templates";
import { deconstruct, detectSurface, type BrailleSurface } from "@/backend/braille/deconstruct";
import { syncLabels, syncLabelsForAllAccounts, listCaptureAccounts, accountEmailFor } from "@/backend/gmail/sync-service";
import { exportSheetsToJson } from "@/backend/google/sheet-export";
import { exportDocsToFiles } from "@/backend/google/doc-export";
import { isValidCron } from "@/backend/gmail/cron";
import { captureAccount, captureAllAccounts } from "@/backend/gmail/capture-service";
import { searchGmail } from "@/backend/gmail/search-service";
import { uploadMessageAttachments, subjectFromPayload } from "@/backend/gmail/attachment-drive";
import { attachmentManifest } from "@/backend/gmail/attachments";
import { walkFolder, auditSharing, applySharingActions, DEFAULT_MAX_NODES } from "@/backend/drive/sharing-audit";
import { runCodeMode, runCodeModeSearch } from "./code-mode";
import { deployMergedVersion, rollbackDeployment, deploymentHistory } from "@/backend/appscript/deploy-pipeline";
import { resolveStandingScript, setStandingScript } from "@/backend/appscript/standing";
import { buildCodeTextRequests, CODE_THEMES } from "@/backend/docs/code-format";
import { findLastTable } from "@/backend/docs/locate";
import { buildFillRequests, buildTableStyleRequests } from "@/backend/docs/table-format";
import { lintDoc, buildQcFixRequests } from "@/backend/docs/qc";
import { RECIPES, getRequestTypes, type SchemaSurface } from "@/backend/docs/schema";
import { htmlToRequests } from "@/backend/docs/html-to-braille";
import { markdownToRequests } from "@/backend/docs/markdown-to-requests";
import { docBodyContent } from "@/backend/docs/locate";
import { analyzePages, collectHeadings, pdfToPages } from "@/backend/docs/render-qc";
import { SCRIPT_SCAFFOLDS } from "@/backend/docs/appscript-scaffolds";
import { buildTemplate, type BindConfig } from "@/backend/appscript-templates";
import { rasterizePdf, storeRender } from "@/backend/docs/browser-render";
import { DriveService, FOLDER_MIME, escapeDriveQuery, type DriveFile } from "./services/drive";
import { extractGoogleId } from "@/backend/google/core/ids";
import { DocsService } from "./services/docs";
import { SheetsService } from "./services/sheets";
import { GmailService } from "./services/gmail";
import { SlidesService } from "./services/slides";
import { CalendarService } from "./services/calendar";
import { AppsScriptService } from "./services/appsscript";
import { CommentsService } from "./services/comments";
import { ChangesService } from "./services/changes";
import { WorkspaceEventsService } from "./services/workspaceevents";
import { PeopleService } from "./services/people";
import { FormsService } from "./services/forms";
import { queryCorpus } from "@/backend/ai/rag";
import { GoogleDocsClient } from "@/backend/google";
import { reviewDoc, sweepComments, collabConfig } from "@/backend/docs/comment-collab";
import type { AssetAction } from "./logging";

export type ToolCtx = { env: Env; sub: string };

export type ToolAsset = {
  assetType: string;
  googleId: string;
  title?: string;
  url?: string;
  action: AssetAction;
  detail?: Record<string, unknown>;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  /** Advertised on the MCP surface (tools/list) so clients know the result shape. */
  outputSchema?: z.ZodType<any>;
  run(ctx: ToolCtx, args: any): Promise<{ result: unknown; asset?: ToolAsset }>;
};

/** Output shape of both code-mode tools — the sandbox execution result. */
const codeModeResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  logs: z.array(z.string()),
});

/** Optional impersonation field mixed into every tool schema. */
const asUser = {
  as_user: z
    .string()
    .email()
    .optional()
    .describe(
      "Optional email to act as. Uses a stored per-user OAuth refresh token for that account when one exists (works for consumer/standalone mailboxes), otherwise falls back to Workspace domain-wide delegation. Omit to use the signed-in account (default).",
    ),
};

/**
 * Rich-body + attachment fields mixed into the Gmail compose tools. The worker
 * owns formatting: it inlines CSS (Gmail ignores <style>/classes) and renders
 * markdown, so the model just supplies content. Attachments over Gmail's 25 MiB
 * ceiling auto-fall back to "anyone with link" Drive links (like Gmail).
 */
const richBody = {
  html: z
    .string()
    .optional()
    .describe("Rich HTML body. The worker inlines all CSS for Gmail — you do NOT need to write inline styles yourself. Takes precedence over `body`."),
  markdown: z
    .string()
    .optional()
    .describe("Markdown body. The worker renders it to Gmail-safe inline-styled HTML (headings, bold, lists, links, tables). Takes precedence over `body`."),
  attachments: z
    .array(
      z.union([
        z.object({ driveFileId: z.string(), as: z.enum(["attach", "link"]).optional() }),
        z.object({ blob: z.string().describe("base64"), filename: z.string(), mimeType: z.string().optional(), as: z.enum(["attach", "link"]).optional() }),
      ]),
    )
    .optional()
    .describe(
      "Attachments, each ONE of: { driveFileId } (attach the Drive file's bytes), { blob, filename, mimeType } (attach inline base64), or { driveFileId, as:'link' } (force a shared Drive link instead of attaching). Processed in order; when the cumulative encoded size would exceed Gmail's 25 MiB cap (~18 MiB raw), the overflow files auto-fall back to 'anyone with link' Drive links added at the top of the email. The tool result's `attachments` report says how each was delivered (attached | linked-by-request | linked-over-limit) with the link URL.",
    ),
  driveIds: z
    .array(z.string())
    .optional()
    .describe("Legacy shorthand for attachments: Drive file ids to attach (same size/link fallback as `attachments`)."),
  blobs: z
    .array(z.object({ filename: z.string(), mimeType: z.string().optional(), contentBase64: z.string() }))
    .optional()
    .describe("Legacy shorthand for attachments: inline base64 files (same size/link fallback as `attachments`)."),
};

/** Resolve the account ref for a call: DWD impersonation, or the OAuth caller. */
export function acct(sub: string, a: { as_user?: string }): string {
  return a.as_user ? `dwd:${a.as_user}` : sub;
}

/**
 * Read-only, account-scoped tools eligible for mandatory cross-account "shadow
 * search" (see {@link file://./tool-runner.ts}). The same read is re-run in every
 * OTHER registered account and an `_shadowSearch` FYI is attached, so the model
 * can self-correct when it targeted the wrong account (an id/query that returns
 * nothing in account A but has hits in account B).
 *
 * ONLY read-only tools belong here: shadowing re-invokes the tool in another
 * account, so a write/execute (gmail_send, appsscript_run, *_create/update, Drive
 * mutations) would cause real side effects in a second mailbox. Never add one.
 * gmail_get_thread is excluded on both counts — its default path writes to Drive,
 * and a threadId is account-scoped so a cross-account lookup is meaningless.
 */
export const SHADOW_TOOLS = new Set<string>([
  // Drive — id lookups + name/query search + sharing audit
  "search_files",
  "list_recent_files",
  "get_file_metadata",
  "get_file_permissions",
  "read_file_content",
  "download_file_content",
  "list_folder_children",
  "list_folder_recursive",
  "drive_audit_sharing",
  // Docs / Sheets / Slides — read by id
  "docs_get",
  "docs_get_json",
  "sheets_get_values",
  "sheets_get_metadata",
  "slides_get",
  "slides_get_thumbnail",
  // Calendar / People / Forms
  "calendar_list_events",
  "calendar_get_event",
  "calendar_list_calendars",
  "people_list_connections",
  "people_search_contacts",
  "people_search_directory",
  "forms_get",
  "forms_list_responses",
  // Gmail search (threadId lookups are account-scoped, so not gmail_get_thread)
  "gmail_list",
  // Apps Script — read content / deployments by id (NOT appsscript_run)
  "appsscript_get_content",
  "appsscript_list_deployments",
]);

/**
 * Insert braille rows in chunks. D1 caps bound parameters at 100 per query;
 * braille_artifacts has 11 columns, so a single INSERT can hold at most 9
 * rows — chunk at 8 to stay clear.
 */
async function insertBrailleRows(
  db: ReturnType<typeof getDb>,
  rows: (typeof brailleArtifacts.$inferInsert)[],
): Promise<void> {
  const CHUNK = 8;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(brailleArtifacts).values(rows.slice(i, i + CHUNK));
  }
}

/** Cap for in-memory Drive uploads (simple `uploadType=media` buffers the whole body). */
export const MAX_DRIVE_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Decode standard or url-safe base64 to bytes (for binary Drive uploads). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Gmail's compose box renders body text in Arial 11pt, color #222222. A Doc
 * styled this way copy-pastes into Gmail without the font being remapped — the
 * reason gmail_draft_doc exists. rgb 0.13333334 == #222222.
 */
const GMAIL_BODY_TEXT_STYLE = {
  weightedFontFamily: { fontFamily: "Arial", weight: 400 },
  fontSize: { magnitude: 11, unit: "PT" },
  foregroundColor: { color: { rgbColor: { red: 0.13333334, green: 0.13333334, blue: 0.13333334 } } },
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
};
const GMAIL_BODY_STYLE_FIELDS = "weightedFontFamily,fontSize,foregroundColor,bold,italic,underline,strikethrough";

/**
 * Place a freshly-created Doc: move it into `folderRaw` if given, else — when a
 * `keyword` is supplied but no id — leave it in root and return the folders whose
 * name matches (scoped to type:folder) so the caller can pick one and move_file.
 * Shared by docs_create and gmail_draft_doc.
 */
async function placeNewDoc(
  drive: DriveService,
  documentId: string,
  folderRaw: string | undefined,
  keyword: string | undefined,
): Promise<{ folderId: string | null; folderMatches: DriveFile[] | null }> {
  const folderId = folderRaw ? extractGoogleId(folderRaw) : null;
  if (folderId) {
    await drive.moveFile(documentId, folderId);
    return { folderId, folderMatches: null };
  }
  if (keyword?.trim()) {
    const kw = escapeDriveQuery(keyword.trim());
    const q = `name contains '${kw}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    return { folderId: null, folderMatches: (await drive.search(q, 20)).files };
  }
  return { folderId: null, folderMatches: null };
}

export const TOOLS: ToolDef[] = [
  // ---- Drive -------------------------------------------------------------
  {
    name: "search_files",
    description: "Search Google Drive files. Optional query in Drive query syntax (e.g. \"name contains 'report'\").",
    inputSchema: z.object({ query: z.string().optional(), pageSize: z.number().int().min(1).max(100).optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).search(a.query, a.pageSize) };
    },
  },
  {
    name: "list_recent_files",
    description: "List the most recently modified Drive files.",
    inputSchema: z.object({ pageSize: z.number().int().min(1).max(100).optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).listRecent(a.pageSize) };
    },
  },
  {
    name: "get_file_metadata",
    description: "Get a Drive file's metadata (id, name, mimeType, link) by id.",
    inputSchema: z.object({ fileId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).get(a.fileId);
      return { result: f, asset: { assetType: "drive", googleId: f.id, title: f.name, url: f.webViewLink, action: "read" } };
    },
  },
  {
    name: "get_file_permissions",
    description: "List the permissions (who has access, and what role) on a Drive file.",
    inputSchema: z.object({ fileId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).getPermissions(a.fileId), asset: { assetType: "drive", googleId: a.fileId, action: "read" } };
    },
  },
  {
    name: "read_file_content",
    description:
      "Read a Drive file's content as text. Google Docs/Sheets/Slides are exported (to text/csv); other files are read directly. Best for feeding file content to the model.",
    inputSchema: z.object({ fileId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const out = await new DriveService(env, acct(sub, a)).readContent(a.fileId);
      return { result: out, asset: { assetType: "drive", googleId: a.fileId, action: "read", detail: { exported: out.exported } } };
    },
  },
  {
    name: "download_file_content",
    description: "Download a Drive file's raw media content as text (alt=media). For binary files prefer read_file_content.",
    inputSchema: z.object({ fileId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).downloadContent(a.fileId), asset: { assetType: "drive", googleId: a.fileId, action: "read" } };
    },
  },
  {
    name: "create_file",
    description: "Create a Drive file with text content and an explicit mimeType (e.g. text/plain, text/markdown, text/csv).",
    inputSchema: z.object({ name: z.string(), mimeType: z.string(), content: z.string(), parentId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).createFile(a.name, a.mimeType, a.content, a.parentId);
      return { result: f, asset: { assetType: "drive", googleId: f.id, title: f.name, url: f.webViewLink, action: "create", detail: { mimeType: a.mimeType } } };
    },
  },
  {
    name: "copy_file",
    description: "Copy a Drive file to a new file (optionally into a target folder).",
    inputSchema: z.object({ fileId: z.string(), name: z.string(), targetFolderId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).copy(a.fileId, a.name, a.targetFolderId);
      return { result: f, asset: { assetType: "drive", googleId: f.id, title: f.name, url: f.webViewLink, action: "create", detail: { copiedFrom: a.fileId } } };
    },
  },
  {
    name: "drive_create_folder",
    description: "Create a Drive folder.",
    inputSchema: z.object({ name: z.string(), parentId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).createFolder(a.name, a.parentId);
      return { result: f, asset: { assetType: "drive", googleId: f.id, title: f.name, url: f.webViewLink, action: "create", detail: { name: a.name } } };
    },
  },
  {
    name: "drive_upload_file",
    description:
      "Upload a document to Drive from base64 bytes (any binary type — PDF, docx, images, …). Target the destination by `folderId`, or by `folderPath` (a '/'-separated path like 'Clients/Acme/2026' whose folders are auto-created); omit both to land in My Drive root. Returns { id, name, url, folderId } — the Drive file id and shareable webViewLink. For plain-text content prefer create_file; for a real HTTP multipart file upload use POST /api/drive/upload.",
    inputSchema: z.object({
      name: z.string().describe("File name including extension, e.g. 'invoice.pdf'."),
      mimeType: z.string().describe("MIME type of the bytes, e.g. 'application/pdf'."),
      contentBase64: z.string().describe("File bytes, base64-encoded (standard or url-safe)."),
      folderId: z.string().optional().describe("Destination folder id. Takes precedence over folderPath."),
      folderPath: z.string().optional().describe("'/'-separated destination folder path; missing segments are created."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const bytes = base64ToBytes(a.contentBase64);
      if (bytes.length > MAX_DRIVE_UPLOAD_BYTES) {
        throw new Error(`File too large (${bytes.length} bytes); max ${MAX_DRIVE_UPLOAD_BYTES}.`);
      }
      const drive = new DriveService(env, acct(sub, a));
      // Accept a pasted Drive folder URL as well as a bare id.
      const folderId = a.folderId ? extractGoogleId(a.folderId) : a.folderPath ? await drive.resolveFolderPath(a.folderPath) : undefined;
      const f = await drive.uploadBinary(a.name, a.mimeType, bytes, folderId);
      const url = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
      return {
        result: { id: f.id, name: f.name, url, folderId: folderId ?? null },
        asset: { assetType: "drive", googleId: f.id, title: f.name, url, action: "create", detail: { folderId, folderPath: a.folderPath } },
      };
    },
  },
  {
    name: "share_file",
    description: "Share a Drive file: grant a role (reader/commenter/writer/owner) to a type (user/group/domain/anyone), optionally an emailAddress.",
    inputSchema: z.object({
      fileId: z.string(),
      role: z.enum(["reader", "commenter", "writer", "owner"]),
      type: z.enum(["user", "group", "domain", "anyone"]),
      emailAddress: z.string().email().optional(),
      sendNotificationEmail: z.boolean().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const r = await new DriveService(env, acct(sub, a)).share(a.fileId, a.role, a.type, a.emailAddress, a.sendNotificationEmail ?? false);
      return { result: r, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { role: a.role, type: a.type } } };
    },
  },
  {
    name: "update_file",
    description: "Rename and/or move a Drive file (name, addParents, removeParents).",
    inputSchema: z.object({ fileId: z.string(), name: z.string().optional(), addParents: z.string().optional(), removeParents: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).updateFile(a.fileId, { name: a.name, addParents: a.addParents, removeParents: a.removeParents });
      return { result: f, asset: { assetType: "drive", googleId: a.fileId, title: a.name, action: "update" } };
    },
  },
  {
    name: "export_file",
    description: "Export a Google-native file to a given mimeType (e.g. application/pdf, text/plain, text/csv) and return the content.",
    inputSchema: z.object({ fileId: z.string(), mimeType: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).exportFile(a.fileId, a.mimeType), asset: { assetType: "drive", googleId: a.fileId, action: "read", detail: { export: a.mimeType } } };
    },
  },
  {
    name: "rename_file",
    description: "Rename a Drive file or folder.",
    inputSchema: z.object({ fileId: z.string(), name: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).updateFile(a.fileId, { name: a.name });
      return { result: f, asset: { assetType: "drive", googleId: a.fileId, title: a.name, action: "update", detail: { rename: a.name } } };
    },
  },
  {
    name: "move_file",
    description: "Move a Drive file or folder into a target folder (detaches it from its current parents). Give the destination as `targetFolderId` (aliases: `folderId`, `parentFolderId`).",
    inputSchema: z
      .object({
        fileId: z.string(),
        targetFolderId: z.string().optional(),
        folderId: z.string().optional().describe("Alias for targetFolderId."),
        parentFolderId: z.string().optional().describe("Alias for targetFolderId."),
        ...asUser,
      })
      .refine((v) => Boolean(v.targetFolderId ?? v.folderId ?? v.parentFolderId), {
        message: "Provide a destination folder (targetFolderId, folderId, or parentFolderId).",
      }),
    async run({ env, sub }, a) {
      const dest = (a.targetFolderId ?? a.folderId ?? a.parentFolderId)!;
      const f = await new DriveService(env, acct(sub, a)).moveFile(a.fileId, dest);
      return { result: f, asset: { assetType: "drive", googleId: a.fileId, action: "update", detail: { movedTo: dest } } };
    },
  },
  {
    name: "trash_file",
    description: "Move a Drive file or folder to the trash (reversible). Pass `restore:true` to un-trash instead. This is NOT a permanent delete — items stay recoverable in Drive trash.",
    inputSchema: z.object({ fileId: z.string(), restore: z.boolean().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new DriveService(env, acct(sub, a)).trashFile(a.fileId, !a.restore);
      return { result: f, asset: { assetType: "drive", googleId: a.fileId, action: "update", detail: { trashed: !a.restore } } };
    },
  },
  {
    name: "list_folder_children",
    description: "List the direct children (files + folders) of a Drive folder. Paginated via pageToken.",
    inputSchema: z.object({ folderId: z.string(), pageToken: z.string().optional(), pageSize: z.number().int().min(1).max(1000).optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new DriveService(env, acct(sub, a)).listChildren(a.folderId, { pageToken: a.pageToken, pageSize: a.pageSize }) };
    },
  },
  {
    name: "list_folder_recursive",
    description:
      "Recursively list every descendant (files + folders) under a Drive folder. Bounded by maxNodes (default 2000); returns truncated:true if the tree is larger.",
    inputSchema: z.object({ folderId: z.string(), maxNodes: z.number().int().min(1).max(5000).optional(), ...asUser }),
    async run({ env, sub }, a) {
      const { nodes, truncated } = await walkFolder(new DriveService(env, acct(sub, a)), a.folderId, a.maxNodes ?? DEFAULT_MAX_NODES);
      const files = nodes.map((n) => ({ id: n.id, name: n.name, mimeType: n.mimeType, parents: n.parents, webViewLink: n.webViewLink }));
      return { result: { rootId: a.folderId, count: files.length, truncated, files } };
    },
  },
  {
    name: "delete_permission",
    description: "Remove a single permission from a Drive file or folder by permissionId (see get_file_permissions).",
    inputSchema: z.object({ fileId: z.string(), permissionId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      await new DriveService(env, acct(sub, a)).deletePermission(a.fileId, a.permissionId);
      return { result: { ok: true }, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { removedPermission: a.permissionId } } };
    },
  },
  {
    name: "drive_audit_sharing",
    description:
      "Audit sharing across a Drive folder tree (recursive). Returns counts of files/folders shared to 'anyone with the link', and — when auditEmails is given — per-account shared/not-shared counts. Bounded by maxNodes (default 2000; truncated:true if exceeded).",
    inputSchema: z.object({
      folderId: z.string(),
      auditEmails: z.array(z.string().email()).optional().describe("Accounts to report explicit shared/not-shared counts for."),
      maxNodes: z.number().int().min(1).max(5000).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const drive = new DriveService(env, acct(sub, a));
      const { nodes, truncated } = await walkFolder(drive, a.folderId, a.maxNodes ?? DEFAULT_MAX_NODES);
      return { result: auditSharing(a.folderId, nodes, truncated, a.auditEmails ?? []), asset: { assetType: "drive", googleId: a.folderId, action: "read", detail: { audited: nodes.length } } };
    },
  },
  {
    name: "drive_update_sharing_recursive",
    description:
      "Apply sharing changes across a Drive folder tree (recursive, includes the root). Any combination of: addAnyoneWithLink (grant anyone-with-link a role), removeAnyoneWithLink (strip all anyone permissions), removeEmails (revoke accounts), addEmails (grant accounts a role). Bounded by maxNodes; per-node failures are collected, not fatal.",
    inputSchema: z
      .object({
        folderId: z.string(),
        addAnyoneWithLink: z.enum(["reader", "commenter", "writer"]).optional(),
        removeAnyoneWithLink: z.boolean().optional(),
        removeEmails: z.array(z.string().email()).optional(),
        addEmails: z.array(z.object({ email: z.string().email(), role: z.enum(["reader", "commenter", "writer"]) })).optional(),
        maxNodes: z.number().int().min(1).max(5000).optional(),
        ...asUser,
      })
      .refine(
        (v) => v.addAnyoneWithLink || v.removeAnyoneWithLink || (v.removeEmails?.length ?? 0) > 0 || (v.addEmails?.length ?? 0) > 0,
        { message: "Provide at least one action (addAnyoneWithLink, removeAnyoneWithLink, removeEmails, or addEmails)." },
      ),
    async run({ env, sub }, a) {
      const result = await applySharingActions(
        new DriveService(env, acct(sub, a)),
        a.folderId,
        {
          addAnyoneWithLink: a.addAnyoneWithLink,
          removeAnyoneWithLink: a.removeAnyoneWithLink,
          removeEmails: a.removeEmails,
          addEmails: a.addEmails,
        },
        a.maxNodes ?? DEFAULT_MAX_NODES,
      );
      return { result, asset: { assetType: "drive", googleId: a.folderId, action: "modify", detail: { scanned: result.scanned } } };
    },
  },
  // ---- Docs --------------------------------------------------------------
  {
    name: "docs_get",
    description: "Get a Google Doc by id.",
    inputSchema: z.object({ documentId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const d = await new DocsService(env, acct(sub, a)).get(a.documentId);
      return { result: d, asset: { assetType: "doc", googleId: d.documentId, title: d.title, action: "read" } };
    },
  },
  {
    name: "docs_create",
    description:
      "Create a Google Doc with a title. Folder placement is OPTIONAL: " +
      "(1) pass `folderId` (alias `parentFolderId`) to place it — the Docs API always creates in My Drive root, so the doc is created then re-parented into that folder in one step; " +
      "(2) pass `folderKeyword` when you know the folder by name but not its id — the doc is created (left in root) and the tool returns `folderMatches`, the folders whose name contains the keyword (search is scoped to type:folder), so you can then move_file the doc into the one you want; " +
      "(3) pass neither to just create in root. The acting account (see `as_user`) must have write access to the destination folder. Returns { documentId, title, folderId, folderMatches }.",
    inputSchema: z.object({
      title: z.string(),
      folderId: z.string().optional().describe("Destination folder id (or URL). The new doc is moved here after creation."),
      parentFolderId: z.string().optional().describe("Alias for folderId."),
      folderKeyword: z
        .string()
        .optional()
        .describe("Folder name keyword. When set (and no folderId), the doc is left in root and matching folders (type:folder) are returned as `folderMatches` for a follow-up move_file."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = acct(sub, a);
      const drive = new DriveService(env, account);
      const d = await new DocsService(env, account).create(a.title);
      const { folderId, folderMatches } = await placeNewDoc(drive, d.documentId, a.folderId ?? a.parentFolderId, a.folderKeyword);
      return {
        result: { ...d, folderId, folderMatches },
        asset: { assetType: "doc", googleId: d.documentId, title: d.title, action: "create", detail: { folderId } },
      };
    },
  },
  {
    name: "gmail_draft_doc",
    description:
      "Create a Gmail message DRAFT as a Google Doc, pre-styled in Gmail's standard body format (Arial 11pt, color #222222) so it copy-pastes into the Gmail compose window without the font being remapped. Pass the message text as `body` (plain text; blank lines separate paragraphs) — it is inserted and styled in one step. Folder placement is optional and works exactly like docs_create: `folderId`/`parentFolderId` to place it, or `folderKeyword` to get back matching folders (type:folder) for a follow-up move_file, or neither to leave it in My Drive root. Acts as `as_user` (must have write access to any target folder). Returns { documentId, title, url, folderId, folderMatches }.",
    inputSchema: z.object({
      title: z.string().describe("Doc title (e.g. the email subject)."),
      body: z.string().optional().describe("Message text. Inserted at the top and styled Gmail-standard. Use blank lines between paragraphs."),
      folderId: z.string().optional().describe("Destination folder id (or URL). The draft is moved here after creation."),
      parentFolderId: z.string().optional().describe("Alias for folderId."),
      folderKeyword: z
        .string()
        .optional()
        .describe("Folder name keyword. When set (and no folderId), the draft is left in root and matching folders are returned as `folderMatches` for a follow-up move_file."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = acct(sub, a);
      const docs = new DocsService(env, account);
      const drive = new DriveService(env, account);
      const d = await docs.create(a.title);

      const body = a.body ?? "";
      if (body) {
        // Insert the text then style the exact range it occupies — one atomic batch.
        await docs.batchUpdate(d.documentId, [
          { insertText: { location: { index: 1 }, text: body } },
          { updateTextStyle: { range: { startIndex: 1, endIndex: 1 + body.length }, textStyle: GMAIL_BODY_TEXT_STYLE, fields: GMAIL_BODY_STYLE_FIELDS } },
        ]);
      }

      const { folderId, folderMatches } = await placeNewDoc(drive, d.documentId, a.folderId ?? a.parentFolderId, a.folderKeyword);
      return {
        result: { ...d, url: `https://docs.google.com/document/d/${d.documentId}/edit`, folderId, folderMatches },
        asset: { assetType: "doc", googleId: d.documentId, title: d.title, action: "create", detail: { folderId, gmailStyled: Boolean(body) } },
      };
    },
  },
  {
    name: "docs_insert_text",
    description: "Insert text into a Google Doc at an index (default 1).",
    inputSchema: z.object({ documentId: z.string(), text: z.string(), index: z.number().int().optional(), ...asUser }),
    async run({ env, sub }, a) {
      await new DocsService(env, acct(sub, a)).insertText(a.documentId, a.text, a.index);
      return { result: { ok: true }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { inserted: a.text.length } } };
    },
  },
  {
    name: "docs_replace_text",
    description: "Replace all occurrences of a string in a Google Doc.",
    inputSchema: z.object({ documentId: z.string(), find: z.string(), replace: z.string(), matchCase: z.boolean().optional(), ...asUser }),
    async run({ env, sub }, a) {
      await new DocsService(env, acct(sub, a)).replaceText(a.documentId, a.find, a.replace, a.matchCase);
      return { result: { ok: true }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { replace: a.find } } };
    },
  },
  {
    name: "docs_insert_image",
    description: "Insert an inline image (by public URL) into a Google Doc at an index (default 1).",
    inputSchema: z.object({ documentId: z.string(), uri: z.string().url(), index: z.number().int().optional(), ...asUser }),
    async run({ env, sub }, a) {
      await new DocsService(env, acct(sub, a)).insertImage(a.documentId, a.uri, a.index);
      return { result: { ok: true }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { image: true } } };
    },
  },
  {
    name: "docs_style_text",
    description:
      "Style EXISTING text in a Google Doc by matching the literal string — NO index math. Finds `find` (the nth `instance`, default 1), resolves its real UTF-16 range, and applies character styles (bold/italic/underline/strikethrough/color/backgroundColor/fontSize/fontFamily/link) and/or a paragraph `namedStyleType` (HEADING_1..6/TITLE/SUBTITLE/NORMAL_TEXT). This is the reliable way to 'bold this sentence' / 'color that phrase' / 'make this a heading' — use it instead of hand-authoring docs_batch_update indices (which drift as edits apply). Throws if the text isn't found. Defaults to the SA identity; as_user overrides.",
    inputSchema: z.object({
      documentId: z.string(),
      find: z.string().min(1),
      instance: z.number().int().min(1).optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      fontSize: z.number().positive().optional().describe("Points."),
      fontFamily: z.string().optional(),
      color: z.string().optional().describe("Foreground hex, #RRGGBB or #RGB."),
      backgroundColor: z.string().optional().describe("Highlight hex, #RRGGBB or #RGB."),
      linkUrl: z.string().url().optional(),
      namedStyleType: z
        .enum([
          "NORMAL_TEXT",
          "TITLE",
          "SUBTITLE",
          "HEADING_1",
          "HEADING_2",
          "HEADING_3",
          "HEADING_4",
          "HEADING_5",
          "HEADING_6",
        ])
        .optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const docs = new GoogleDocsClient(env, account);
      const range = await docs.findElement(a.documentId, a.find, a.instance ?? 1);
      if (!range) {
        throw new Error(`Text not found: ${JSON.stringify(a.find)}${a.instance ? ` (instance ${a.instance})` : ""}`);
      }
      await docs.applyTextStyle(a.documentId, range.startIndex, range.endIndex, {
        bold: a.bold,
        italic: a.italic,
        underline: a.underline,
        strikethrough: a.strikethrough,
        fontSize: a.fontSize,
        fontFamily: a.fontFamily,
        foregroundColor: a.color,
        backgroundColor: a.backgroundColor,
        linkUrl: a.linkUrl,
      });
      if (a.namedStyleType) {
        await docs.applyParagraphStyle(a.documentId, range.startIndex, range.endIndex, { namedStyleType: a.namedStyleType });
      }
      return {
        result: { documentId: a.documentId, range },
        asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { styledText: a.find.slice(0, 40) } },
      };
    },
  },
  // ---- Sheets ------------------------------------------------------------
  {
    name: "sheets_create",
    description: "Create a spreadsheet with a title.",
    inputSchema: z.object({ title: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const s = await new SheetsService(env, acct(sub, a)).create(a.title);
      return { result: s, asset: { assetType: "sheet", googleId: s.spreadsheetId, title: a.title, action: "create" } };
    },
  },
  {
    name: "sheets_get_values",
    description: "Read a range of values from a spreadsheet (A1 notation).",
    inputSchema: z.object({ spreadsheetId: z.string(), range: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const v = await new SheetsService(env, acct(sub, a)).getValues(a.spreadsheetId, a.range);
      return { result: v, asset: { assetType: "sheet", googleId: a.spreadsheetId, action: "read", detail: { range: a.range } } };
    },
  },
  {
    name: "sheets_append_values",
    description: "Append rows to a spreadsheet range (A1 notation).",
    inputSchema: z.object({ spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.string())), ...asUser }),
    async run({ env, sub }, a) {
      await new SheetsService(env, acct(sub, a)).appendValues(a.spreadsheetId, a.range, a.values);
      return { result: { ok: true }, asset: { assetType: "sheet", googleId: a.spreadsheetId, action: "update", detail: { rows: a.values.length } } };
    },
  },
  {
    name: "sheets_get_metadata",
    description: "Get a spreadsheet's metadata: title + the list of tabs (sheetId, title, index).",
    inputSchema: z.object({ spreadsheetId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new SheetsService(env, acct(sub, a)).getMetadata(a.spreadsheetId), asset: { assetType: "sheet", googleId: a.spreadsheetId, action: "read" } };
    },
  },
  {
    name: "sheets_export_json",
    description:
      "Export one or MANY Google Spreadsheets to a JSON file (reflecting ALL tabs), saved beside each source sheet in Drive, and return each JSON file's Drive id, view url, and direct download url. " +
      "`sheets` accepts a Drive id OR a full Drive/Sheets url, as a single value OR an array, freely mixed (ids and urls together) — each url is reduced to its id automatically. " +
      "IMPORTANT — if the user did NOT give you a specific spreadsheet id or url, do NOT guess: first call search_files to find candidates, CONFIRM with the user which file they mean, then call this with the confirmed id/url. " +
      "Cross-account is automatic: the sheet may live in any registered account (e.g. jmbish04@ vs justin@); each account is tried until one can read it, and the winning account is reported per item. " +
      "Each ref is processed independently — a bad/inaccessible id yields an error report item without aborting the rest. `shape`: 'records' (each tab → objects keyed by the header row, default) or 'values' (raw 2-D arrays). Every run is tracked in D1 (sheet_export_jobs).",
    inputSchema: z.object({
      sheets: z.union([z.string(), z.array(z.string()).min(1)]).describe("Drive id or url, or an array of them (ids/urls may be mixed)."),
      shape: z.enum(["records", "values"]).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      // Order accounts with the caller's intended account first; the rest are
      // automatic cross-account fallback for sheets owned elsewhere.
      const primaryEmail = await accountEmailFor(env, acct(sub, a));
      const registered = await listCaptureAccounts(env);
      const accounts = [
        ...registered.filter((x) => x.email === primaryEmail),
        ...registered.filter((x) => x.email !== primaryEmail),
      ];
      if (!accounts.some((x) => x.email === primaryEmail)) {
        accounts.unshift({ email: primaryEmail, ref: acct(sub, a) });
      }

      const results = await exportSheetsToJson(env, accounts, a.sheets, a.shape ?? "records");

      // One requestId groups this call's rows; dedupe is within-request only (see
      // exportSheetsToJson) — a later call re-exports, tracked under a new requestId.
      const requestId = crypto.randomUUID();
      const db = getDb(env);
      const rows = results.map((r) => ({
        requestId,
        requestedRef: r.requested,
        spreadsheetId: r.spreadsheetId,
        sourceAccount: r.sourceAccount ?? null,
        triedAccounts: r.triedAccounts,
        status: r.status,
        tabCount: r.tabCount ?? null,
        jsonDriveId: r.jsonDriveId ?? null,
        jsonDriveUrl: r.jsonDriveUrl ?? null,
        jsonDownloadUrl: r.jsonDownloadUrl ?? null,
        jsonSha256: r.jsonSha256 ?? null,
        sourceModifiedTime: r.sourceModifiedTime ?? null,
        error: r.error ?? null,
      }));
      // ~14 bound cols/row → chunk under D1's 100-param cap.
      for (let i = 0; i < rows.length; i += 6) {
        await db.insert(sheetExportJobs).values(rows.slice(i, i + 6));
      }

      const firstDone = results.find((r) => r.status === "done");
      return {
        result: {
          requestId,
          results,
          summary: { total: results.length, done: results.filter((r) => r.status === "done").length },
        },
        asset: firstDone?.jsonDriveId
          ? { assetType: "drive", googleId: firstDone.jsonDriveId, title: "sheet export JSON", url: firstDone.jsonDriveUrl, action: "create" as const }
          : undefined,
      };
    },
  },
  {
    name: "docs_export",
    description:
      "Export one or MANY Google Docs to a file saved beside each source doc in Drive, returning each file's Drive id, view url, and download url. `docs` accepts a Drive id OR a Docs/Drive url, single or an array, freely mixed — each is normalized to its id. " +
      "IMPORTANT — if the user did NOT give a specific id/url, do NOT guess: search_files first, CONFIRM which doc with the user, then export the confirmed ref. " +
      "`format` (default 'pdf'): pdf | markdown | docx | html | txt | odt | rtf | epub. " +
      "`tab` (default 'all'): 'all' = whole document in the chosen format; 'first' or a tabId = a single tab — but single-tab export is Markdown-only (Google has no native per-tab PDF), so a single tab with a non-markdown format is reported as an error for that item. " +
      "Cross-account is automatic (the doc may live in any registered account); each ref is processed independently (a bad id yields an error item, others still run). Every run is tracked in D1 (doc_export_jobs) with a requestId, content hash, and the source doc's modifiedTime.",
    inputSchema: z.object({
      docs: z.union([z.string(), z.array(z.string()).min(1)]).describe("Drive id or url, or an array of them (ids/urls may be mixed)."),
      format: z.enum(["pdf", "markdown", "docx", "html", "txt", "odt", "rtf", "epub"]).optional(),
      tab: z.string().optional().describe("'all' (default), 'first', or a specific tabId. Single-tab is markdown-only."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const primaryEmail = await accountEmailFor(env, acct(sub, a));
      const registered = await listCaptureAccounts(env);
      const accounts = [
        ...registered.filter((x) => x.email === primaryEmail),
        ...registered.filter((x) => x.email !== primaryEmail),
      ];
      if (!accounts.some((x) => x.email === primaryEmail)) {
        accounts.unshift({ email: primaryEmail, ref: acct(sub, a) });
      }

      const results = await exportDocsToFiles(env, accounts, a.docs, a.format ?? "pdf", a.tab ?? "all");

      const requestId = crypto.randomUUID();
      const db = getDb(env);
      const rows = results.map((r) => ({
        requestId,
        requestedRef: r.requested,
        documentId: r.documentId,
        sourceAccount: r.sourceAccount ?? null,
        triedAccounts: r.triedAccounts,
        status: r.status,
        format: r.format,
        tabScope: r.tabScope,
        exportDriveId: r.exportDriveId ?? null,
        exportDriveUrl: r.exportDriveUrl ?? null,
        exportDownloadUrl: r.exportDownloadUrl ?? null,
        exportSha256: r.exportSha256 ?? null,
        sourceModifiedTime: r.sourceModifiedTime ?? null,
        error: r.error ?? null,
      }));
      // ~14 bound cols/row → chunk under D1's 100-param cap.
      for (let i = 0; i < rows.length; i += 6) {
        await db.insert(docExportJobs).values(rows.slice(i, i + 6));
      }

      const firstDone = results.find((r) => r.status === "done");
      return {
        result: {
          requestId,
          results,
          summary: { total: results.length, done: results.filter((r) => r.status === "done").length },
        },
        asset: firstDone?.exportDriveId
          ? { assetType: "drive", googleId: firstDone.exportDriveId, title: `doc export (${firstDone.format})`, url: firstDone.exportDriveUrl, action: "create" as const }
          : undefined,
      };
    },
  },
  {
    name: "sheets_add_sheet",
    description: "Add a new tab (sheet) to a spreadsheet.",
    inputSchema: z.object({ spreadsheetId: z.string(), title: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      await new SheetsService(env, acct(sub, a)).addSheet(a.spreadsheetId, a.title);
      return { result: { ok: true }, asset: { assetType: "sheet", googleId: a.spreadsheetId, action: "modify", detail: { addSheet: a.title } } };
    },
  },
  {
    name: "sheets_batch_update",
    description: "Apply raw Sheets API batchUpdate requests (formatting, addSheet, updateCells, conditional formats, etc.).",
    inputSchema: z.object({ spreadsheetId: z.string(), requests: z.array(z.record(z.string(), z.any())), ...asUser }),
    async run({ env, sub }, a) {
      await new SheetsService(env, acct(sub, a)).batchUpdate(a.spreadsheetId, a.requests);
      return { result: { ok: true }, asset: { assetType: "sheet", googleId: a.spreadsheetId, action: "modify", detail: { requests: a.requests.length } } };
    },
  },
  // ---- Slides ------------------------------------------------------------
  {
    name: "slides_create",
    description: "Create a Google Slides presentation with a title.",
    inputSchema: z.object({ title: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const p = await new SlidesService(env, acct(sub, a)).create(a.title);
      return { result: p, asset: { assetType: "slide", googleId: p.presentationId, title: a.title, action: "create" } };
    },
  },
  {
    name: "slides_get",
    description: "Get a Slides presentation (title + slides) by id.",
    inputSchema: z.object({ presentationId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const p = await new SlidesService(env, acct(sub, a)).get(a.presentationId);
      return { result: p, asset: { assetType: "slide", googleId: a.presentationId, title: p.title, action: "read" } };
    },
  },
  {
    name: "slides_batch_update",
    description: "Apply raw Slides API batchUpdate requests (createSlide, insertText, etc.) to a presentation.",
    inputSchema: z.object({ presentationId: z.string(), requests: z.array(z.record(z.string(), z.any())), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new SlidesService(env, acct(sub, a)).batchUpdate(a.presentationId, a.requests);
      return { result: r, asset: { assetType: "slide", googleId: a.presentationId, action: "modify", detail: { requests: a.requests.length } } };
    },
  },
  {
    name: "slides_create_from_markdown",
    description:
      "Create a Slides presentation FROM MARKDOWN (--- separates slides; '# '/'## ' = title; '- ' = bullets; '![](url)' = image). Returns the presentationId and a map of deterministic object IDs per slide (slideObjectId/titleId/bodyId/imageId) so you can then style each element with slides_batch_update. This is one way to build slides — slides_create + slides_batch_update remain for full control.",
    inputSchema: z.object({ title: z.string(), markdown: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const out = await new SlidesService(env, acct(sub, a)).createFromMarkdown(a.title, a.markdown);
      return { result: out, asset: { assetType: "slide", googleId: out.presentationId, title: a.title, action: "create", detail: { slides: out.slides.length, fromMarkdown: true } } };
    },
  },
  {
    name: "slides_replace_all_text",
    description: "Replace all occurrences of text across a presentation (great for filling a template). replacements = [{find, replace, matchCase?}].",
    inputSchema: z.object({ presentationId: z.string(), replacements: z.array(z.object({ find: z.string(), replace: z.string(), matchCase: z.boolean().optional() })), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new SlidesService(env, acct(sub, a)).replaceAllText(a.presentationId, a.replacements);
      return { result: r, asset: { assetType: "slide", googleId: a.presentationId, action: "modify", detail: { replacements: a.replacements.length } } };
    },
  },
  {
    name: "slides_get_thumbnail",
    description: "Get a rendered thumbnail image URL for a slide/page — lets you SEE a slide before styling it.",
    inputSchema: z.object({ presentationId: z.string(), pageObjectId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new SlidesService(env, acct(sub, a)).getThumbnail(a.presentationId, a.pageObjectId), asset: { assetType: "slide", googleId: a.presentationId, action: "read" } };
    },
  },
  {
    name: "slides_style_text",
    description:
      "Style all text in a text box/shape (bold, italic, underline, fontSize, fontFamily, foregroundColorHex #RRGGBB, link) without hand-writing an updateTextStyle batchUpdate request.",
    inputSchema: z.object({
      presentationId: z.string(),
      objectId: z.string(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      fontSize: z.number().optional(),
      fontFamily: z.string().optional(),
      foregroundColorHex: z.string().optional(),
      link: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const r = await new SlidesService(env, acct(sub, a)).styleText(a.presentationId, a.objectId, {
        bold: a.bold,
        italic: a.italic,
        underline: a.underline,
        fontSize: a.fontSize,
        fontFamily: a.fontFamily,
        foregroundColorHex: a.foregroundColorHex,
        link: a.link,
      });
      return { result: r, asset: { assetType: "slide", googleId: a.presentationId, action: "modify", detail: { objectId: a.objectId } } };
    },
  },
  {
    name: "slides_style_shape",
    description: "Style a shape's fill/outline color (backgroundColorHex/outlineColorHex, both #RRGGBB) without hand-writing an updateShapeProperties batchUpdate request.",
    inputSchema: z.object({
      presentationId: z.string(),
      objectId: z.string(),
      backgroundColorHex: z.string().optional(),
      outlineColorHex: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const r = await new SlidesService(env, acct(sub, a)).styleShape(a.presentationId, a.objectId, {
        backgroundColorHex: a.backgroundColorHex,
        outlineColorHex: a.outlineColorHex,
      });
      return { result: r, asset: { assetType: "slide", googleId: a.presentationId, action: "modify", detail: { objectId: a.objectId } } };
    },
  },
  {
    name: "slides_set_slide_background",
    description: "Set a slide's background to a solid color (colorHex #RRGGBB) without hand-writing an updatePageProperties batchUpdate request.",
    inputSchema: z.object({ presentationId: z.string(), pageObjectId: z.string(), colorHex: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new SlidesService(env, acct(sub, a)).setSlideBackground(a.presentationId, a.pageObjectId, a.colorHex);
      return { result: r, asset: { assetType: "slide", googleId: a.presentationId, action: "modify", detail: { pageObjectId: a.pageObjectId } } };
    },
  },
  // ---- Calendar ----------------------------------------------------------
  {
    name: "calendar_list_events",
    description: "List calendar events (default calendar 'primary'). Optional time window (RFC3339) + text query.",
    inputSchema: z.object({
      calendarId: z.string().optional(),
      timeMin: z.string().optional(),
      timeMax: z.string().optional(),
      q: z.string().optional(),
      maxResults: z.number().int().min(1).max(250).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const out = await new CalendarService(env, acct(sub, a)).listEvents(a.calendarId ?? "primary", {
        timeMin: a.timeMin,
        timeMax: a.timeMax,
        q: a.q,
        maxResults: a.maxResults,
      });
      return { result: out };
    },
  },
  {
    name: "calendar_get_event",
    description: "Get a single calendar event by id.",
    inputSchema: z.object({ calendarId: z.string().optional(), eventId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const e = await new CalendarService(env, acct(sub, a)).getEvent(a.calendarId ?? "primary", a.eventId);
      return { result: e, asset: { assetType: "calendar", googleId: a.eventId, title: e.summary, url: e.htmlLink, action: "read" } };
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Create a calendar event. start/end are Google EventDateTime objects, e.g. { dateTime: '2026-01-15T10:00:00Z' } or { date: '2026-01-15' }.",
    inputSchema: z.object({
      calendarId: z.string().optional(),
      summary: z.string(),
      description: z.string().optional(),
      start: z.record(z.string(), z.any()),
      end: z.record(z.string(), z.any()),
      attendees: z.array(z.object({ email: z.string().email() })).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const e = await new CalendarService(env, acct(sub, a)).createEvent(a.calendarId ?? "primary", {
        summary: a.summary,
        description: a.description,
        start: a.start,
        end: a.end,
        attendees: a.attendees,
      });
      return { result: e, asset: { assetType: "calendar", googleId: e.id, title: a.summary, url: e.htmlLink, action: "create" } };
    },
  },
  {
    name: "calendar_update_event",
    description: "Patch/update fields of an existing calendar event.",
    inputSchema: z.object({ calendarId: z.string().optional(), eventId: z.string(), patch: z.record(z.string(), z.any()), ...asUser }),
    async run({ env, sub }, a) {
      const e = await new CalendarService(env, acct(sub, a)).updateEvent(a.calendarId ?? "primary", a.eventId, a.patch);
      return { result: e, asset: { assetType: "calendar", googleId: a.eventId, action: "update" } };
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete a calendar event.",
    inputSchema: z.object({ calendarId: z.string().optional(), eventId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new CalendarService(env, acct(sub, a)).deleteEvent(a.calendarId ?? "primary", a.eventId);
      return { result: r, asset: { assetType: "calendar", googleId: a.eventId, action: "delete" } };
    },
  },
  {
    name: "calendar_quick_add",
    description: "Create an event from natural-language text (e.g. 'Lunch with Sam tomorrow 12pm').",
    inputSchema: z.object({ calendarId: z.string().optional(), text: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const e = await new CalendarService(env, acct(sub, a)).quickAdd(a.calendarId ?? "primary", a.text);
      return { result: e, asset: { assetType: "calendar", googleId: e.id, title: e.summary, url: e.htmlLink, action: "create" } };
    },
  },
  {
    name: "calendar_list_calendars",
    description: "List the calendars on the user's calendar list.",
    inputSchema: z.object({ ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new CalendarService(env, acct(sub, a)).listCalendars() };
    },
  },
  // ---- Gmail -------------------------------------------------------------
  {
    name: "gmail_list",
    description: "List Gmail messages matching an optional query.",
    inputSchema: z.object({ query: z.string().optional(), maxResults: z.number().int().min(1).max(100).optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new GmailService(env, acct(sub, a)).listMessages(a.query, a.maxResults) };
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a Gmail DRAFT (not sent) so a human can review before sending. Preferred over gmail_send for agent workflows. For formatting use `html` or `markdown` (the worker inlines CSS for Gmail); attach files with `driveIds`/`blobs`.",
    inputSchema: z.object({ to: z.string().email(), subject: z.string(), body: z.string().optional(), ...richBody, ...asUser }),
    async run({ env, sub }, a) {
      const d = await new GmailService(env, acct(sub, a)).createDraft(a.to, a.subject, a.body ?? "", {
        html: a.html,
        markdown: a.markdown,
        attachments: a.attachments,
        driveIds: a.driveIds,
        blobs: a.blobs,
      });
      return { result: d, asset: { assetType: "gmail", googleId: d.id, title: a.subject, action: "create", detail: { to: a.to, draft: true } } };
    },
  },
  {
    name: "gmail_create_reply_draft",
    description:
      "Create a DRAFT reply to an existing message (same thread, proper In-Reply-To/References). Defaults to REPLY-ALL (original sender + all To/Cc, minus you). Pass `to` to reply to specific addresses only, or replyAll:false to reply to the sender only. Draft, not sent — for human review.",
    inputSchema: z.object({
      messageId: z.string(),
      body: z.string().optional(),
      to: z.array(z.string().email()).optional(),
      replyAll: z.boolean().optional(),
      ...richBody,
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const d = await new GmailService(env, acct(sub, a)).createReplyDraft(a.messageId, a.body ?? "", {
        to: a.to,
        replyAll: a.replyAll,
        html: a.html,
        markdown: a.markdown,
        attachments: a.attachments,
        driveIds: a.driveIds,
        blobs: a.blobs,
      });
      return { result: d, asset: { assetType: "gmail", googleId: d.id, action: "create", detail: { replyTo: a.messageId, draft: true } } };
    },
  },
  {
    name: "gmail_send",
    description:
      "Send an email immediately. Use `html` or `markdown` for formatting (the worker inlines CSS for Gmail); attach with `driveIds`/`blobs` (auto Drive-link fallback over 25 MiB). Pass replyToMessageId (or threadId) to reply within an existing thread. Prefer gmail_create_draft when a human should review first.",
    inputSchema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string().optional(),
      replyToMessageId: z
        .string()
        .optional()
        .describe("Reply to this message id: sets In-Reply-To/References and keeps the reply in the original thread."),
      threadId: z.string().optional().describe("Explicit Gmail threadId to attach the message to (overrides replyToMessageId's thread)."),
      ...richBody,
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const sent = await new GmailService(env, acct(sub, a)).send(a.to, a.subject, a.body ?? "", {
        from: a.as_user,
        replyToMessageId: a.replyToMessageId,
        threadId: a.threadId,
        html: a.html,
        markdown: a.markdown,
        attachments: a.attachments,
        driveIds: a.driveIds,
        blobs: a.blobs,
      });
      return {
        result: sent,
        asset: {
          assetType: "gmail",
          googleId: sent.id,
          title: a.subject,
          action: "create",
          detail: { to: a.to, ...(a.replyToMessageId ? { replyTo: a.replyToMessageId } : {}), ...(sent.threadId ? { threadId: sent.threadId } : {}) },
        },
      };
    },
  },
  {
    name: "gmail_schedule_send",
    description:
      "Schedule an existing Gmail DRAFT to be sent later on a cron schedule (UTC). Flow: create the draft first (gmail_create_draft) to get a draftId, then call this with draftId + a 5-field cron. An hourly worker checks pending schedules and, once a cron occurrence has passed, sends the draft and marks it sent. Cron is UTC, 5 fields (minute hour day-of-month month day-of-week). Examples: '0 14 * * 1' = 14:00 UTC every Monday; '30 9 5 * *' = 09:30 UTC on the 5th of the month.",
    inputSchema: z.object({
      draftId: z.string().describe("Gmail draft id from gmail_create_draft."),
      cron: z.string().describe("5-field UTC cron: minute hour day-of-month month day-of-week."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      if (!isValidCron(a.cron)) {
        throw new Error(
          `Invalid cron "${a.cron}". Use 5 UTC fields: minute hour day-of-month month day-of-week (e.g. "0 14 * * 1").`,
        );
      }
      const ref = acct(sub, a);
      const email = await accountEmailFor(env, ref);
      const [row] = await getDb(env)
        .insert(scheduledSends)
        .values({ draftId: a.draftId, accountRef: ref, accountEmail: email, cron: a.cron })
        .returning({ id: scheduledSends.id });
      return {
        result: { id: row.id, draftId: a.draftId, cron: a.cron, account: email, timezone: "UTC", status: "scheduled" },
      };
    },
  },
  {
    name: "schedule_email",
    description:
      "Schedule an email to send at an absolute future time. IMPORTANT: Gmail has NO native scheduled-send API (its 'Schedule send' is UI-only) — this is a worker-side queue: the full message is persisted and a background sweep sends it at `send_at`, atomically (no double-send). Takes the SAME inputs as gmail_send (to, subject, body/html/markdown, attachments) PLUS `send_at`. YOU must resolve relative phrases ('Monday 9am') to a concrete ISO-8601 UTC instant before calling — this tool only accepts a timestamp. Prefer Drive file ids over large inline blobs (blobs are stored inline; keep them small, re-fetch big files via driveFileId at send time). Manage the queue with list_scheduled_emails / cancel_scheduled_email.",
    inputSchema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string().optional(),
      send_at: z.string().describe("Absolute send time as ISO-8601 UTC (e.g. '2026-08-18T16:00:00Z'). Resolve relative phrases yourself first."),
      ...richBody,
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const when = new Date(a.send_at);
      if (Number.isNaN(when.getTime())) {
        throw new Error(`Invalid send_at "${a.send_at}". Pass an absolute ISO-8601 UTC instant, e.g. "2026-08-18T16:00:00Z".`);
      }
      const ref = acct(sub, a);
      const email = await accountEmailFor(env, ref);
      const spec: ScheduledEmailSpec = {
        to: a.to,
        subject: a.subject,
        body: a.body,
        html: a.html,
        markdown: a.markdown,
        attachments: a.attachments,
        driveIds: a.driveIds,
        blobs: a.blobs,
      };
      const [row] = await getDb(env)
        .insert(scheduledEmails)
        .values({ accountRef: ref, accountEmail: email, spec, sendAt: when, status: "scheduled" })
        .returning({ id: scheduledEmails.id });
      return {
        result: { id: row.id, to: a.to, subject: a.subject, sendAt: when.toISOString(), account: email, status: "scheduled" },
      };
    },
  },
  {
    name: "list_scheduled_emails",
    description:
      "List queued scheduled emails (schedule_email), newest send-time first. Shows id, recipient, subject, send time, status (scheduled | sending | sent | error | canceled), and any last error.",
    inputSchema: z.object({
      status: z.enum(["scheduled", "sending", "sent", "error", "canceled"]).optional().describe("Filter to one status."),
    }),
    async run({ env }, a) {
      const db = getDb(env);
      const rows = a.status
        ? await db.select().from(scheduledEmails).where(eq(scheduledEmails.status, a.status)).orderBy(desc(scheduledEmails.sendAt)).limit(200)
        : await db.select().from(scheduledEmails).orderBy(desc(scheduledEmails.sendAt)).limit(200);
      return {
        result: {
          scheduledEmails: rows.map((r) => ({
            id: r.id,
            to: r.spec.to,
            subject: r.spec.subject,
            sendAt: r.sendAt instanceof Date ? r.sendAt.toISOString() : r.sendAt,
            status: r.status,
            account: r.accountEmail,
            messageId: r.messageId,
            error: r.error,
          })),
        },
      };
    },
  },
  {
    name: "cancel_scheduled_email",
    description:
      "Cancel a queued scheduled email by id — only while still pending (status 'scheduled'). Returns { canceled: true } if it was pending and is now canceled, or { canceled: false } if it was already sent/sending/canceled.",
    inputSchema: z.object({ id: z.number().int() }),
    async run({ env }, a) {
      // Conditional update: only cancel a still-'scheduled' row (never a sending/sent one).
      const canceled = await getDb(env)
        .update(scheduledEmails)
        .set({ status: "canceled" })
        .where(and(eq(scheduledEmails.id, a.id), eq(scheduledEmails.status, "scheduled")))
        .returning({ id: scheduledEmails.id });
      return { result: { id: a.id, canceled: canceled.length === 1 } };
    },
  },
  {
    name: "email_preview_host",
    description:
      "Render an email draft to Gmail-safe inlined HTML and HOST it on the worker frontend, returning a direct preview URL the user can open to eyeball the email before sending. Use this when the user wants to SEE a draft: ask them first, and if yes, call this and give them the returned `url`. Accepts the same body inputs as gmail_send (body / html / markdown). The preview renders in a sandboxed iframe.",
    inputSchema: z.object({
      subject: z.string().optional(),
      to: z.string().optional(),
      body: z.string().optional(),
      html: z.string().optional(),
      markdown: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const composed = composeBody({ text: a.body, html: a.html, markdown: a.markdown });
      const html = composed.html ?? `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap;">${composed.text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)}</pre>`;
      const id = crypto.randomUUID();
      const account = await accountEmailFor(env, acct(sub, a)).catch(() => undefined);
      await getDb(env).insert(emailPreviews).values({ id, subject: a.subject ?? null, toAddr: a.to ?? null, html, account: account ?? null });
      const base = (env as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL;
      const path = `/gws/email-preview/${id}`;
      return { result: { id, path, url: base ? `${base}${path}` : path } };
    },
  },
  {
    name: "email_templates_list",
    description:
      "List available Gmail-safe HTML email templates (built-in best-practice ones + user-added), for the model to pick a solid starting core. Returns id, name, description, category, isBuiltin. Fetch the full HTML with email_template_get.",
    inputSchema: z.object({ category: z.string().optional() }),
    async run({ env }, a) {
      await seedBuiltinTemplates(env);
      const db = getDb(env);
      const rows = a.category
        ? await db.select().from(emailTemplates).where(eq(emailTemplates.category, a.category))
        : await db.select().from(emailTemplates);
      return {
        result: {
          templates: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, isBuiltin: t.isBuiltin })),
        },
      };
    },
  },
  {
    name: "email_template_get",
    description:
      "Get one email template's full Gmail-inlined HTML by id (from email_templates_list). Fill its {{placeholders}} then send with gmail_send/gmail_create_draft `html`.",
    inputSchema: z.object({ id: z.string() }),
    async run({ env }, a) {
      await seedBuiltinTemplates(env);
      const [t] = await getDb(env).select().from(emailTemplates).where(eq(emailTemplates.id, a.id)).limit(1);
      if (!t) throw new Error(`Template ${a.id} not found. Use email_templates_list to see available ids.`);
      return { result: { id: t.id, name: t.name, description: t.description, category: t.category, html: t.html, isBuiltin: t.isBuiltin } };
    },
  },
  {
    name: "email_template_add",
    description:
      "Add a reusable email template to the marketplace. The HTML is sanitized + CSS-inlined for Gmail on save (use {{placeholders}} for fill-in fields). Returns the new template id.",
    inputSchema: z.object({
      name: z.string(),
      html: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
    }),
    async run({ env, sub }, a) {
      const id = crypto.randomUUID();
      await getDb(env)
        .insert(emailTemplates)
        .values({ id, name: a.name, description: a.description ?? null, category: a.category ?? null, html: inlineGmailStyles(a.html), isBuiltin: false, createdBySub: sub });
      return { result: { id, name: a.name, status: "added" } };
    },
  },
  {
    name: "gmail_attachments_to_drive",
    description:
      "Upload a message's (non-junk) attachments to the acting account's Google Drive and extract their text. Defaults to a folder named after the thread subject under the per-account 'MCP Email Threads' folder (created on first use); pass parentId to target a specific folder instead. Returns each attachment as { filename, driveId, driveUrl, mimetype, size, sha256_hash, doc_text }.",
    inputSchema: z.object({
      messageId: z.string(),
      parentId: z.string().optional().describe("Target Drive folder id. Omit to use the thread-subject folder under 'MCP Email Threads'."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = acct(sub, a);
      const gmail = new GmailService(env, account);
      const raw = await gmail.getRawMessage(a.messageId);
      const payload = (raw as { payload?: unknown }).payload;
      const subject = subjectFromPayload(payload) ?? "(no subject)";
      const { folderId, attachments } = await uploadMessageAttachments(env, account, a.as_user ?? sub, {
        messageId: a.messageId,
        payload,
        subject,
        parentId: a.parentId,
        gmail,
      });
      return {
        result: { folderId, attachments },
        asset: folderId
          ? { assetType: "drive", googleId: folderId, title: subject, action: "modify", detail: { attachments: attachments.length } }
          : undefined,
      };
    },
  },
  {
    name: "gmail_get_thread",
    description:
      "Get a full Gmail thread (all messages) by threadId — best for feeding conversation context to the model. Every message ALWAYS carries an attachments[] manifest of { filename, mimeType, size, attachmentId } so the model knows attachments exist. By default each message's attachments are ALSO uploaded to the acting account's Drive (thread-subject folder under 'MCP Email Threads') and the manifest is enriched with { driveId, doc_text, sha256_hash }. Pass includeAttachments:false to skip all Drive writes and return the raw thread with the metadata-only manifest.",
    inputSchema: z.object({ threadId: z.string(), includeAttachments: z.boolean().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = acct(sub, a);
      const gmail = new GmailService(env, account);
      const thread = await gmail.getThread(a.threadId);
      if (a.includeAttachments === false) {
        // Still surface attachment metadata (count/filename/mimeType/size) for
        // every message — cheap payload walk, no Drive writes — so the model is
        // never blind to attachments just because byte-fetching was skipped.
        const messages = thread.messages.map((m) => ({ ...m, attachments: attachmentManifest(m.payload) }));
        return { result: { ...thread, messages } };
      }

      const accountKey = a.as_user ?? sub;
      const subject = thread.messages.map((m) => subjectFromPayload(m.payload)).find(Boolean) ?? "(no subject)";
      // Resolve the thread folder once (on the first message that has attachments)
      // and reuse it for the rest, so the whole thread lands in one folder.
      let folderId: string | undefined;
      const messages = [];
      for (const m of thread.messages) {
        const up = await uploadMessageAttachments(env, account, accountKey, {
          messageId: m.id,
          payload: m.payload,
          subject,
          folderId,
          gmail,
        });
        if (up.folderId) folderId = up.folderId;
        messages.push({ ...m, attachments: up.attachments });
      }
      return { result: { ...thread, messages, attachmentsFolderId: folderId ?? null } };
    },
  },
  {
    name: "gmail_list_labels",
    description: "List Gmail labels (id + name).",
    inputSchema: z.object({ ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new GmailService(env, acct(sub, a)).listLabels() };
    },
  },
  {
    name: "gmail_create_label",
    description: "Create a Gmail label.",
    inputSchema: z.object({ name: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new GmailService(env, acct(sub, a)).createLabel(a.name) };
    },
  },
  {
    name: "gmail_modify_labels",
    description: "Add and/or remove labels on a Gmail message (e.g. archive by removing INBOX, mark read by removing UNREAD).",
    inputSchema: z.object({ id: z.string(), addLabelIds: z.array(z.string()).optional(), removeLabelIds: z.array(z.string()).optional(), ...asUser }),
    async run({ env, sub }, a) {
      const m = await new GmailService(env, acct(sub, a)).modifyMessageLabels(a.id, a.addLabelIds ?? [], a.removeLabelIds ?? []);
      return { result: m, asset: { assetType: "gmail", googleId: a.id, action: "modify" } };
    },
  },
  {
    name: "gmail_trash_message",
    description: "Move a Gmail message to Trash.",
    inputSchema: z.object({ id: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const m = await new GmailService(env, acct(sub, a)).trashMessage(a.id);
      return { result: m, asset: { assetType: "gmail", googleId: a.id, action: "delete" } };
    },
  },
  // ---- Apps Script (escape hatch) ---------------------------------------
  {
    name: "appsscript_create_project",
    description: "Create a standalone Apps Script project, returning its scriptId.",
    inputSchema: z.object({ title: z.string(), parentId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const p = await new AppsScriptService(env, acct(sub, a)).createProject(a.title, a.parentId);
      return { result: p, asset: { assetType: "script", googleId: p.scriptId, title: a.title, action: "create" } };
    },
  },
  {
    name: "appscript_bind_doc",
    description:
      "Attach a container-bound Apps Script to an EXISTING Doc/Sheet/Slides file and push a ready-to-use template in one step. Creates the bound project on `parentId`, assembles the chosen template plus your `config` (custom menu + questions schema), and writes the code over the REST API — no clasp, no CI. Templates: 'agent-questions' (custom menu + JSON-driven questions sidebar; on submit the answers land in a new Doc tab / Sheet tab / appendix slide depending on the host — the AI follow-up-questions flow), 'webapp' (doGet HTML web app), or legacy 'sidebar'/'chat-sidebar'. Returns scriptId + editor URL. For 'webapp', deploy afterwards with appsscript_deploy. You must have edit access to the target file. Defaults to the signed-in account.",
    inputSchema: z.object({
      parentId: z.string().describe("The Doc/Sheet/Slides file ID or URL to bind the script to."),
      template: z.enum(["agent-questions", "webapp", "sidebar", "chat-sidebar"]),
      config: z
        .object({
          title: z.string(),
          menu: z
            .object({ name: z.string().optional(), items: z.array(z.object({ label: z.string(), fn: z.string() })) })
            .optional(),
          questions: z
            .object({
              title: z.string(),
              intro: z.string().optional(),
              outputTitle: z.string().optional(),
              fields: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  type: z.enum(["text", "textarea", "single", "multi"]),
                  options: z.array(z.string()).optional(),
                }),
              ),
            })
            .optional(),
          webapp: z.object({ title: z.string().optional(), intro: z.string().optional() }).optional(),
        })
        .describe("Per-doc config: project title, custom menu, questions schema, and/or web-app settings."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const svc = new AppsScriptService(env, acct(sub, a));
      const project = await svc.createProject(a.config.title, a.parentId);
      const files = buildTemplate(a.template, a.config as BindConfig);
      await svc.updateContent(project.scriptId, files);
      const url = `https://script.google.com/d/${project.scriptId}/edit`;
      return {
        result: { scriptId: project.scriptId, url, template: a.template, files: files.map((f) => f.name) },
        asset: {
          assetType: "script",
          googleId: project.scriptId,
          title: a.config.title,
          action: "create",
          detail: { template: a.template, parentId: a.parentId },
        },
      };
    },
  },
  {
    name: "appsscript_get_content",
    description: "Get the files (code + manifest) of an Apps Script project.",
    inputSchema: z.object({ scriptId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new AppsScriptService(env, acct(sub, a)).getContent(a.scriptId), asset: { assetType: "script", googleId: a.scriptId, action: "read" } };
    },
  },
  {
    name: "appsscript_update_content",
    description:
      "Push code to an Apps Script project (overwrites all files). `files` is the Apps Script files array (an appsscript manifest JSON file + one or more SERVER_JS files).",
    inputSchema: z.object({ scriptId: z.string(), files: z.array(z.record(z.string(), z.any())), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new AppsScriptService(env, acct(sub, a)).updateContent(a.scriptId, a.files);
      return { result: r, asset: { assetType: "script", googleId: a.scriptId, action: "update", detail: { files: a.files.length } } };
    },
  },
  {
    name: "appsscript_run",
    description:
      "Execute a function in a deployed Apps Script project (must be deployed as an API Executable). Params/return are basic JSON types only.",
    inputSchema: z.object({
      scriptId: z.string(),
      functionName: z.string(),
      parameters: z.array(z.any()).optional(),
      devMode: z.boolean().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const r = await new AppsScriptService(env, acct(sub, a)).run(a.scriptId, a.functionName, a.parameters, a.devMode ?? true);
      return { result: r, asset: { assetType: "script", googleId: a.scriptId, action: "modify", detail: { function: a.functionName } } };
    },
  },
  {
    name: "appsscript_list_processes",
    description: "List recent Apps Script execution processes (status + history).",
    inputSchema: z.object({ ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new AppsScriptService(env, acct(sub, a)).listProcesses() };
    },
  },
  // ---- Drive comments (agent collaboration) ------------------------------
  {
    name: "comments_list",
    description: "List comments on a Drive file (with replies). Includes resolved/anchored info.",
    inputSchema: z.object({ fileId: z.string(), includeDeleted: z.boolean().optional(), pageSize: z.number().int().min(1).max(100).optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new CommentsService(env, acct(sub, a)).list(a.fileId, { includeDeleted: a.includeDeleted, pageSize: a.pageSize }), asset: { assetType: "drive", googleId: a.fileId, action: "read" } };
    },
  },
  {
    name: "comments_find_mentions",
    description:
      "Find comments/replies on a file that mention a tag (e.g. '#colby') so an agent can pick up work it was tagged in. Case-insensitive substring match on comment content.",
    inputSchema: z.object({ fileId: z.string(), tag: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new CommentsService(env, acct(sub, a)).findMentions(a.fileId, a.tag), asset: { assetType: "drive", googleId: a.fileId, action: "read" } };
    },
  },
  {
    name: "comments_get",
    description: "Get a single comment (with replies) on a Drive file.",
    inputSchema: z.object({ fileId: z.string(), commentId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new CommentsService(env, acct(sub, a)).get(a.fileId, a.commentId) };
    },
  },
  {
    name: "comments_create",
    description: "Create a comment on a Drive file. Optional `anchor` (JSON string) to anchor it to a region; omit for an unanchored comment.",
    inputSchema: z.object({ fileId: z.string(), content: z.string(), anchor: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const c = await new CommentsService(env, acct(sub, a)).create(a.fileId, a.content, a.anchor);
      return { result: c, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { commentId: c.id } } };
    },
  },
  {
    name: "comments_reply",
    description: "Reply to a comment on a Drive file.",
    inputSchema: z.object({ fileId: z.string(), commentId: z.string(), content: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new CommentsService(env, acct(sub, a)).reply(a.fileId, a.commentId, a.content);
      return { result: r, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { commentId: a.commentId, reply: true } } };
    },
  },
  {
    name: "comments_resolve",
    description: "Resolve (close) a comment on a Drive file by posting a resolving reply.",
    inputSchema: z.object({ fileId: z.string(), commentId: z.string(), content: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new CommentsService(env, acct(sub, a)).resolve(a.fileId, a.commentId, a.content);
      return { result: r, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { commentId: a.commentId, resolved: true } } };
    },
  },
  {
    name: "comments_review",
    description:
      "Run the @colby-app comment-collaboration agent. With `fileId`, reviews that doc's tagged threads now; without it, sweeps recently-modified docs for open call-sign comments. `mode`: 'auto' (model decides comment vs suggest), 'comment' (review notes only), 'suggest' (apply edits as native Docs suggestions). Skips any thread an MCP tool has claimed via comments_claim.",
    inputSchema: z.object({
      fileId: z.string().optional(),
      mode: z.enum(["auto", "comment", "suggest"]).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const mode = a.mode ?? "auto";
      if (a.fileId) {
        const docs = new GoogleDocsClient(env, acct(sub, a));
        const result = await reviewDoc(env, docs, a.fileId, { mode });
        return { result, asset: { assetType: "drive", googleId: a.fileId, action: "modify" } };
      }
      return { result: await sweepComments(env, { mode }) };
    },
  },
  {
    name: "comments_claim",
    description:
      "Claim a comment thread for an external MCP tool by posting the standby marker '<callSign> standby, mcp tool handling'. The worker's @colby-app cron/agent then backs off that thread so your own model can carry the conversation via comments_reply.",
    inputSchema: z.object({ fileId: z.string(), commentId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const marker = collabConfig(env).standbyMarker;
      const r = await new CommentsService(env, acct(sub, a)).reply(a.fileId, a.commentId, marker);
      return { result: r, asset: { assetType: "drive", googleId: a.fileId, action: "modify", detail: { commentId: a.commentId, claimed: true } } };
    },
  },
  // ---- Drive changes (classic watch/list) --------------------------------
  {
    name: "changes_get_start_page_token",
    description: "Get a Drive changes start page token — the cursor to begin tracking changes from now.",
    inputSchema: z.object({ driveId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new ChangesService(env, acct(sub, a)).getStartPageToken(a.driveId) };
    },
  },
  {
    name: "changes_list",
    description: "List Drive changes since a page token. Returns changes + a newStartPageToken to persist for the next poll.",
    inputSchema: z.object({
      pageToken: z.string(),
      includeRemoved: z.boolean().optional(),
      includeItemsFromAllDrives: z.boolean().optional(),
      restrictToMyDrive: z.boolean().optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      driveId: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      return {
        result: await new ChangesService(env, acct(sub, a)).list(a.pageToken, {
          includeRemoved: a.includeRemoved,
          includeItemsFromAllDrives: a.includeItemsFromAllDrives,
          restrictToMyDrive: a.restrictToMyDrive,
          pageSize: a.pageSize,
          driveId: a.driveId,
        }),
      };
    },
  },
  {
    name: "changes_watch",
    description:
      "Subscribe to Drive changes via a push channel. `address` is the HTTPS webhook (e.g. this worker's /api/gws/drive-webhook). Returns the channel (id + resourceId) — keep them to stop the watch.",
    inputSchema: z.object({
      pageToken: z.string(),
      channelId: z.string(),
      address: z.string().url(),
      token: z.string().optional(),
      expiration: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      return { result: await new ChangesService(env, acct(sub, a)).watch(a.pageToken, { id: a.channelId, address: a.address, token: a.token, expiration: a.expiration }) };
    },
  },
  {
    name: "changes_stop",
    description: "Stop a Drive changes push channel (from changes_watch).",
    inputSchema: z.object({ channelId: z.string(), resourceId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new ChangesService(env, acct(sub, a)).stop(a.channelId, a.resourceId) };
    },
  },
  // ---- Workspace Events API (fine-grained subscriptions) -----------------
  {
    name: "events_create_subscription",
    description:
      "Create a Workspace Events subscription for a Drive target (file: '//drive.googleapis.com/files/ID' or shared drive: '//drive.googleapis.com/drives/ID') and CloudEvents event types (e.g. 'google.workspace.drive.comment.v3.created'). Events (incl. comment mentions/assignees) are delivered to a Cloud Pub/Sub topic 'projects/P/topics/T'.",
    inputSchema: z.object({
      targetResource: z.string(),
      eventTypes: z.array(z.string()).min(1),
      pubsubTopic: z.string(),
      includeResource: z.boolean().optional(),
      includeDescendants: z.boolean().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      return { result: await new WorkspaceEventsService(env, acct(sub, a)).createSubscription(a.targetResource, a.eventTypes, a.pubsubTopic, { includeResource: a.includeResource, includeDescendants: a.includeDescendants }) };
    },
  },
  {
    name: "events_list_subscriptions",
    description: "List Workspace Events subscriptions. `filter` is required, e.g. event_types:\"google.workspace.drive.file.v3.contentChanged\".",
    inputSchema: z.object({ filter: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new WorkspaceEventsService(env, acct(sub, a)).listSubscriptions(a.filter) };
    },
  },
  {
    name: "events_get_subscription",
    description: "Get a Workspace Events subscription by resource name (subscriptions/ID).",
    inputSchema: z.object({ name: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new WorkspaceEventsService(env, acct(sub, a)).getSubscription(a.name) };
    },
  },
  {
    name: "events_delete_subscription",
    description: "Delete a Workspace Events subscription by resource name (subscriptions/ID).",
    inputSchema: z.object({ name: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new WorkspaceEventsService(env, acct(sub, a)).deleteSubscription(a.name) };
    },
  },
  {
    name: "rag_query",
    description:
      "Semantic search over an indexed RAG corpus (emails | docs | general) via Vectorize embeddings. Returns the top matching chunks. Content must have been indexed by the agents first.",
    inputSchema: z.object({ corpus: z.enum(["emails", "docs", "general"]), query: z.string(), topK: z.number().int().min(1).max(20).optional() }),
    async run({ env }, a) {
      return { result: await queryCorpus(env, a.corpus, a.query, a.topK ?? 5) };
    },
  },
  {
    name: "list_notifications",
    description:
      "List recent push notifications received at the Drive webhook (from changes_watch channels or Workspace Events Pub/Sub push). Poll this to react to file/comment changes.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    async run({ env }, a) {
      const db = getDb(env);
      const rows = await db.select().from(driveNotifications).orderBy(desc(driveNotifications.receivedAt)).limit(a.limit ?? 50);
      return { result: { notifications: rows } };
    },
  },
  // ---- People (contacts + directory) -------------------------------------
  {
    name: "people_get_contact",
    description: "Get a person by resourceName ('people/me' or 'people/c123'). personFields defaults to names,emails,phones,orgs.",
    inputSchema: z.object({ resourceName: z.string(), personFields: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new PeopleService(env, acct(sub, a)).getContact(a.resourceName, a.personFields) };
    },
  },
  {
    name: "people_list_connections",
    description: "List the user's contacts (connections), most-recently-modified first.",
    inputSchema: z.object({ pageSize: z.number().int().min(1).max(1000).optional(), personFields: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new PeopleService(env, acct(sub, a)).listConnections(a.pageSize, a.personFields) };
    },
  },
  {
    name: "people_search_contacts",
    description: "Search the user's own contacts by name/email/phone.",
    inputSchema: z.object({ query: z.string(), readMask: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new PeopleService(env, acct(sub, a)).searchContacts(a.query, a.readMask) };
    },
  },
  {
    name: "people_search_directory",
    description: "Search the Workspace domain directory for people (requires directory access).",
    inputSchema: z.object({ query: z.string(), readMask: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new PeopleService(env, acct(sub, a)).searchDirectory(a.query, a.readMask) };
    },
  },
  {
    name: "people_create_contact",
    description: "Create a new contact (names, emailAddresses, phoneNumbers).",
    inputSchema: z.object({
      names: z.array(z.object({ givenName: z.string().optional(), familyName: z.string().optional() })).optional(),
      emailAddresses: z.array(z.object({ value: z.string() })).optional(),
      phoneNumbers: z.array(z.object({ value: z.string() })).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const p = await new PeopleService(env, acct(sub, a)).createContact({ names: a.names, emailAddresses: a.emailAddresses, phoneNumbers: a.phoneNumbers });
      return { result: p, asset: { assetType: "contact", googleId: p.resourceName, action: "create" } };
    },
  },
  // ---- Forms -------------------------------------------------------------
  {
    name: "forms_create",
    description: "Create a Google Form with a title.",
    inputSchema: z.object({ title: z.string(), documentTitle: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const f = await new FormsService(env, acct(sub, a)).create(a.title, a.documentTitle);
      return { result: f, asset: { assetType: "form", googleId: f.formId, title: a.title, url: f.responderUri, action: "create" } };
    },
  },
  {
    name: "forms_get",
    description: "Get a Google Form (its items/questions + metadata).",
    inputSchema: z.object({ formId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new FormsService(env, acct(sub, a)).get(a.formId), asset: { assetType: "form", googleId: a.formId, action: "read" } };
    },
  },
  {
    name: "forms_add_question",
    description: "Add a question to a Form. No options → a text question; with options → a multiple-choice (RADIO) question.",
    inputSchema: z.object({ formId: z.string(), title: z.string(), options: z.array(z.string()).optional(), required: z.boolean().optional(), index: z.number().int().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new FormsService(env, acct(sub, a)).addQuestion(a.formId, a.title, a.options, a.required ?? false, a.index ?? 0);
      return { result: r, asset: { assetType: "form", googleId: a.formId, action: "modify", detail: { question: a.title } } };
    },
  },
  {
    name: "forms_batch_update",
    description: "Apply raw Forms API batchUpdate requests (add/move/delete items, update settings).",
    inputSchema: z.object({ formId: z.string(), requests: z.array(z.record(z.string(), z.any())), ...asUser }),
    async run({ env, sub }, a) {
      const r = await new FormsService(env, acct(sub, a)).batchUpdate(a.formId, a.requests);
      return { result: r, asset: { assetType: "form", googleId: a.formId, action: "modify", detail: { requests: a.requests.length } } };
    },
  },
  {
    name: "forms_list_responses",
    description: "List the responses submitted to a Google Form.",
    inputSchema: z.object({ formId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new FormsService(env, acct(sub, a)).listResponses(a.formId), asset: { assetType: "form", googleId: a.formId, action: "read" } };
    },
  },
  // ---- Template registry (reference library for agents) ------------------
  {
    name: "list_templates",
    description:
      "List template artifacts from the registry — reusable Drive files (docs/sheets/slides/…) agents can reference or copy. Optional type filter.",
    inputSchema: z.object({ templateType: z.string().optional() }),
    async run({ env }, a) {
      const db = getDb(env);
      const rows = a.templateType
        ? await db.select().from(templateArtifacts).where(eq(templateArtifacts.templateType, a.templateType)).orderBy(desc(templateArtifacts.updatedAt))
        : await db.select().from(templateArtifacts).orderBy(desc(templateArtifacts.updatedAt));
      return { result: { templates: rows } };
    },
  },
  {
    name: "get_template",
    description: "Get one template artifact from the registry by its id.",
    inputSchema: z.object({ id: z.string() }),
    async run({ env }, a) {
      const db = getDb(env);
      const rows = await db.select().from(templateArtifacts).where(eq(templateArtifacts.id, a.id)).limit(1);
      return { result: { template: rows[0] ?? null } };
    },
  },
  {
    name: "instantiate_from_template",
    description:
      "Copy a registry template's Drive file into a new file (optionally in a target folder) and return the new file's id + url. Use this to start from a template instead of a blank document.",
    inputSchema: z.object({ templateId: z.string(), name: z.string(), targetFolderId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const db = getDb(env);
      const rows = await db.select().from(templateArtifacts).where(eq(templateArtifacts.id, a.templateId)).limit(1);
      const tpl = rows[0];
      if (!tpl) throw new Error(`No template with id ${a.templateId}`);
      const copy = await new DriveService(env, acct(sub, a)).copy(tpl.driveId, a.name, a.targetFolderId);
      return {
        result: { id: copy.id, name: copy.name, url: copy.webViewLink, fromTemplate: tpl.id, templateType: tpl.templateType },
        asset: { assetType: tpl.templateType || "drive", googleId: copy.id, title: copy.name, url: copy.webViewLink, action: "create", detail: { fromTemplate: tpl.id } },
      };
    },
  },
  {
    name: "deconstruct_to_braille",
    description:
      "Read a Google Doc, Slides deck, or Sheet and index its structure ('braille') into the D1 registry: one whole-file template row plus one component row per anchor-tagged block ([Component: X]…[End Component]) in a Doc, per slide, or per sheet tab. Builds the reusable component/template library. Surface is auto-detected from the Drive mimeType.",
    inputSchema: z.object({
      fileId: z.string(),
      name: z.string().optional(),
      surface: z.enum(["doc", "slide", "sheet"]).optional(),
      tags: z.array(z.string()).optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      // Default to the service account's own identity (it's shared on the target
      // files); `as_user` overrides to DWD impersonation.
      const account = a.as_user ? acct(sub, a) : "sa";
      const meta = await new DriveService(env, account).get(a.fileId);
      const surface: BrailleSurface | null = a.surface ?? detectSurface(meta.mimeType ?? "");
      if (!surface) {
        throw new Error(`Unsupported file type for braille (mimeType: ${meta.mimeType ?? "unknown"}). Supported: Google Doc, Slides, Sheet.`);
      }

      let raw: unknown;
      if (surface === "doc") raw = await new DocsService(env, account).getRaw(a.fileId);
      else if (surface === "slide") raw = await new SlidesService(env, account).get(a.fileId);
      else raw = await new SheetsService(env, account).getStructure(a.fileId);

      const fragments = deconstruct(surface, raw);
      const baseName = a.name ?? meta.name ?? a.fileId;
      const sourceUrl = meta.webViewLink ?? null;
      const rows = fragments.map((f) => ({
        id: crypto.randomUUID(),
        sourceFileId: a.fileId,
        sourceUrl,
        surface: f.surface,
        kind: f.kind,
        name: f.kind === "template" ? baseName : `${baseName} · ${f.name}`,
        anchor: f.anchor,
        structure: f.structure as Record<string, unknown>,
        tags: a.tags ?? null,
        createdBySub: sub,
      }));
      await insertBrailleRows(getDb(env), rows);

      const template = rows.find((r) => r.kind === "template");
      return {
        result: {
          indexed: rows.length,
          surface,
          templateId: template?.id ?? null,
          components: rows.filter((r) => r.kind === "component").map((r) => ({ id: r.id, name: r.name, anchor: r.anchor })),
        },
        asset: { assetType: surface, googleId: a.fileId, title: baseName, url: sourceUrl ?? undefined, action: "read", detail: { braille: rows.length } },
      };
    },
  },
  {
    name: "braille_list",
    description:
      "List indexed braille artifacts (templates & components) from the registry. Filter by surface, kind, or sourceFileId. Returns metadata only — call braille_get for a specific artifact's full structure.",
    inputSchema: z.object({
      surface: z.enum(["doc", "slide", "sheet"]).optional(),
      kind: z.enum(["template", "component"]).optional(),
      sourceFileId: z.string().optional(),
    }),
    async run({ env }, a) {
      const db = getDb(env);
      const conds = [];
      if (a.surface) conds.push(eq(brailleArtifacts.surface, a.surface));
      if (a.kind) conds.push(eq(brailleArtifacts.kind, a.kind));
      if (a.sourceFileId) conds.push(eq(brailleArtifacts.sourceFileId, a.sourceFileId));
      const cols = {
        id: brailleArtifacts.id,
        name: brailleArtifacts.name,
        surface: brailleArtifacts.surface,
        kind: brailleArtifacts.kind,
        anchor: brailleArtifacts.anchor,
        tags: brailleArtifacts.tags,
        sourceFileId: brailleArtifacts.sourceFileId,
        sourceUrl: brailleArtifacts.sourceUrl,
        createdAt: brailleArtifacts.createdAt,
      };
      const base = db.select(cols).from(brailleArtifacts);
      const rows = await (conds.length ? base.where(and(...conds)) : base).orderBy(desc(brailleArtifacts.createdAt));
      return { result: { artifacts: rows } };
    },
  },
  {
    name: "braille_get",
    description:
      "Get one braille artifact by id, including its full structure JSON — the batchUpdate-replayable braille for a template or component.",
    inputSchema: z.object({ id: z.string() }),
    async run({ env }, a) {
      const db = getDb(env);
      const rows = await db.select().from(brailleArtifacts).where(eq(brailleArtifacts.id, a.id)).limit(1);
      return { result: { artifact: rows[0] ?? null } };
    },
  },
  {
    name: "deconstruct_drive_folder",
    description:
      "Sweep a Drive folder and deconstruct every Google Doc, Slides deck, and Sheet inside it into the braille registry in one call. Other file types are skipped. Accepts a folder id or a Drive folder URL.",
    inputSchema: z.object({ folderId: z.string(), tags: z.array(z.string()).optional(), ...asUser }),
    async run({ env, sub }, a) {
      // Default to the service account's own identity (it's shared on the folder);
      // `as_user` overrides to DWD impersonation.
      const account = a.as_user ? acct(sub, a) : "sa";
      const folderId = (a.folderId.match(/[-\w]{25,}/) ?? [a.folderId])[0];
      const drive = new DriveService(env, account);
      const { files } = await drive.search(`'${folderId}' in parents and trashed = false`, 100);

      const db = getDb(env);
      const results: Array<{ fileId: string; name: string; surface: BrailleSurface; indexed: number }> = [];
      let skipped = 0;

      for (const f of files) {
        const surface = detectSurface(f.mimeType ?? "");
        if (!surface) {
          skipped++;
          continue;
        }
        let raw: unknown;
        if (surface === "doc") raw = await new DocsService(env, account).getRaw(f.id);
        else if (surface === "slide") raw = await new SlidesService(env, account).get(f.id);
        else raw = await new SheetsService(env, account).getStructure(f.id);

        const rows = deconstruct(surface, raw).map((fr) => ({
          id: crypto.randomUUID(),
          sourceFileId: f.id,
          sourceUrl: f.webViewLink ?? null,
          surface: fr.surface,
          kind: fr.kind,
          name: fr.kind === "template" ? f.name : `${f.name} · ${fr.name}`,
          anchor: fr.anchor,
          structure: fr.structure as Record<string, unknown>,
          tags: a.tags ?? null,
          createdBySub: sub,
        }));
        await insertBrailleRows(db, rows);
        results.push({ fileId: f.id, name: f.name, surface, indexed: rows.length });
      }

      return { result: { folderId, filesIndexed: results.length, skipped, results } };
    },
  },
  // ---- Docs batchUpdate engine (braille replay) -------------------------
  {
    name: "docs_get_json",
    description:
      "Return a Google Doc's raw structure JSON (the 'braille'), tab-aware (includeTabsContent=true). This is the exact shape docs_batch_update replays. Defaults to the service-account identity; as_user overrides.",
    inputSchema: z.object({ documentId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      return { result: await new DocsService(env, account).getRaw(a.documentId) };
    },
  },
  {
    name: "docs_batch_update",
    description:
      "Apply an array of native Google Docs API requests to a document atomically — the full grammar: headings, tables, colors, spacing, page/section breaks, tabs (addDocumentTab), landscape (updateSectionStyle flipPageOrientation), styled tables. Each request carries its own tabId/location. This is how stored braille is replayed into docs. Defaults to the service-account identity; as_user overrides.",
    inputSchema: z.object({
      documentId: z.string(),
      requests: z.array(z.record(z.string(), z.unknown())),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const result = await new DocsService(env, account).batchUpdate(a.documentId, a.requests);
      return { result, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { requests: a.requests.length } } };
    },
  },
  {
    name: "table_factory",
    description:
      "Insert a themed table into a Google Doc from a 2D array (first row = header). Header row gets a dark-blue fill with white bold centered text; every cell gets a 1pt border. Handles the index math (fills bottom-up, styles after re-fetch). Defaults to the SA identity.",
    inputSchema: z.object({
      documentId: z.string(),
      data: z.array(z.array(z.string())),
      theme: z.string().optional(),
      tabId: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const docs = new DocsService(env, account);
      const rows = a.data.length;
      const cols = Math.max(0, ...a.data.map((r: string[]) => r.length));
      if (!rows || !cols) throw new Error("data must be a non-empty 2D array");

      await docs.batchUpdate(a.documentId, [{ insertTable: { rows, columns: cols, endOfSegmentLocation: a.tabId ? { tabId: a.tabId } : {} } }]);
      let table = findLastTable(await docs.getRaw(a.documentId), a.tabId);
      if (!table) throw new Error("Could not locate the inserted table.");
      await docs.batchUpdate(a.documentId, buildFillRequests(table, a.data, a.tabId));
      table = findLastTable(await docs.getRaw(a.documentId), a.tabId);
      if (!table) throw new Error("Table not found after fill.");
      await docs.batchUpdate(a.documentId, buildTableStyleRequests(table, a.data, a.theme ?? "default", a.tabId));

      return { result: { documentId: a.documentId, rows, cols }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { table: `${rows}x${cols}` } } };
    },
  },
  {
    name: "code_block_factory",
    description:
      "Insert a syntax-highlighted code block (shaded 1x1 container) into a Google Doc. Tokenizes by language (sql, javascript, typescript, python, bash…) and colors by theme (dracula | github). Defaults to the SA identity.",
    inputSchema: z.object({
      documentId: z.string(),
      code: z.string(),
      language: z.string().optional(),
      theme: z.enum(["dracula", "github"]).optional(),
      tabId: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const docs = new DocsService(env, account);
      const theme = a.theme ?? "github";

      await docs.batchUpdate(a.documentId, [{ insertTable: { rows: 1, columns: 1, endOfSegmentLocation: a.tabId ? { tabId: a.tabId } : {} } }]);
      const table = findLastTable(await docs.getRaw(a.documentId), a.tabId);
      if (!table?.cells[0]) throw new Error("Could not locate the inserted code container.");
      const cellIndex = table.cells[0].startIndex;
      const start = a.tabId ? { index: table.tableStartIndex, tabId: a.tabId } : { index: table.tableStartIndex };
      const bg = (CODE_THEMES[theme] ?? CODE_THEMES.github).background;

      const requests = [
        {
          updateTableCellStyle: {
            tableRange: { tableCellLocation: { tableStartLocation: start, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 },
            tableCellStyle: {
              backgroundColor: { color: { rgbColor: bg } },
              paddingTop: { magnitude: 8, unit: "PT" },
              paddingBottom: { magnitude: 8, unit: "PT" },
              paddingLeft: { magnitude: 10, unit: "PT" },
              paddingRight: { magnitude: 10, unit: "PT" },
            },
            fields: "backgroundColor,paddingTop,paddingBottom,paddingLeft,paddingRight",
          },
        },
        ...buildCodeTextRequests(cellIndex, a.code, a.language ?? "text", theme, a.tabId),
      ];
      await docs.batchUpdate(a.documentId, requests);
      return { result: { documentId: a.documentId, language: a.language ?? "text", theme }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { codeBlock: a.language ?? "text" } } };
    },
  },
  {
    name: "docs_qc_check",
    description:
      "Structural quality check on a Google Doc (from its braille): headings that will orphan (no keepWithNext), tables with no borders, empty paragraphs that render blank pages. Read-only — returns findings. Layout-only issues (table spilling two pages) need the vision QC pass. Defaults to the SA identity.",
    inputSchema: z.object({ documentId: z.string(), tabId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const raw = await new DocsService(env, account).getRaw(a.documentId);
      return { result: { findings: lintDoc(raw, a.tabId) } };
    },
  },
  {
    name: "docs_qc_fix",
    description:
      "Apply the safe white-glove fixes to a Google Doc: keepWithNext on headings (no orphans) and 1pt borders on unstyled tables. Content untouched. Returns what was fixed + any remaining (report-only) findings. This is the polish/apply-style pass. Defaults to the SA identity.",
    inputSchema: z.object({ documentId: z.string(), tabId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const docs = new DocsService(env, account);
      const findings = lintDoc(await docs.getRaw(a.documentId), a.tabId);
      const requests = buildQcFixRequests(findings, a.tabId);
      if (requests.length) await docs.batchUpdate(a.documentId, requests);
      return {
        result: {
          fixed: requests.length,
          remaining: findings.filter((f) => f.rule === "phantom-empty-paragraph"),
          findings,
        },
        asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { qcFixes: requests.length } },
      };
    },
  },
  {
    name: "docs_schema",
    description:
      "Get the batchUpdate request grammar for a Google surface (docs | slides | sheets | forms): curated recipes (correct patterns for styled headers, landscape sections via flipPageOrientation, keep-with-next, tabs) plus the full list of available request-type names. The complete Discovery JSON is served at GET /api/schema/:surface.",
    inputSchema: z.object({ surface: z.enum(["docs", "slides", "sheets", "forms"]) }),
    async run({ env }, a) {
      const surface = a.surface as SchemaSurface;
      const requestTypes = await getRequestTypes(env, surface).catch(() => [] as string[]);
      return { result: { surface, recipes: RECIPES[surface], requestTypes, discoveryUrl: `/api/schema/${surface}` } };
    },
  },
  {
    name: "html_to_doc",
    description:
      "Convert an HTML string into a Google Doc via native batchUpdate (NOT Google's importer) — headings, bold/italic/underline/code, and bullet/numbered lists come out clean. WE control the mapping, so no <hr>-around-heading junk. Inserts at index 1 (use a fresh/scratch doc). Tables/images not yet mapped — use table_factory. Defaults to the SA identity.",
    inputSchema: z.object({ documentId: z.string(), html: z.string(), tabId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const requests = htmlToRequests(a.html, 1, a.tabId);
      if (!requests.length) throw new Error("No renderable content parsed from the HTML.");
      await new DocsService(env, account).batchUpdate(a.documentId, requests);
      return { result: { documentId: a.documentId, blocks: requests.length }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { htmlImport: true } } };
    },
  },
  {
    name: "docs_create_from_markdown",
    description:
      "METHOD 1 (whole new doc): Convert an ENTIRE Markdown string into a NEW native Google Doc using Drive's own Markdown importer. High fidelity — Google maps headings, tables, lists, links, code. Returns the new doc id + url. Use this when the Markdown IS the whole document. To add Markdown to an EXISTING doc, use docs_append_markdown instead. Defaults to the SA identity; as_user overrides.",
    inputSchema: z.object({ name: z.string(), markdown: z.string(), parentId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const f = await new DriveService(env, account).createDocFromMarkdown(a.name, a.markdown, a.parentId);
      return { result: { id: f.id, name: f.name, mimeType: f.mimeType, url: f.webViewLink }, asset: { assetType: "doc", googleId: f.id, title: f.name, url: f.webViewLink, action: "create", detail: { markdownImport: true } } };
    },
  },
  {
    name: "docs_append_markdown",
    description:
      "METHOD 2 (append to existing doc): Convert a Markdown string into native Docs batchUpdate requests and append them to the END of an EXISTING Google Doc — headings become HEADING_n paragraphs, **bold**/*italic*/`code`/bullets/numbered lists are styled. Differs from docs_create_from_markdown, which uses Drive's importer to make a NEW doc. Tables/images are not mapped here (use table_factory / native importer). Pass tabId to append into a specific tab. Defaults to the SA identity; as_user overrides.",
    inputSchema: z.object({ documentId: z.string(), markdown: z.string(), tabId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const docs = new DocsService(env, account);
      const content = docBodyContent(await docs.getRaw(a.documentId), a.tabId);
      // Insert before the final segment newline (the index after the last element is endIndex-1).
      const endIndex = Math.max(1, (content.at(-1)?.endIndex ?? 1) - 1);
      const requests = markdownToRequests(a.markdown, endIndex, a.tabId);
      if (!requests.length) throw new Error("No renderable content parsed from the Markdown.");
      await docs.batchUpdate(a.documentId, requests);
      return { result: { documentId: a.documentId, blocks: requests.length, at: endIndex }, asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { markdownAppend: true } } };
    },
  },
  {
    name: "office_to_google",
    description:
      "Convert an Office file already in Drive (.docx/.xlsx/.pptx) to its Google-native equivalent (Doc/Sheet/Slides) via Drive's converter — far higher fidelity than parsing OpenXML. Returns the new file id + url; then deconstruct_to_braille it. Defaults to the SA identity.",
    inputSchema: z.object({ fileId: z.string(), name: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const f = await new DriveService(env, account).convertToGoogle(a.fileId, a.name);
      return { result: { id: f.id, name: f.name, mimeType: f.mimeType, url: f.webViewLink }, asset: { assetType: "drive", googleId: f.id, title: f.name, url: f.webViewLink, action: "create", detail: { convertedFrom: a.fileId } } };
    },
  },
  {
    name: "render_qc",
    description:
      "Render-level QC across ALL document types (Docs, Sheets, Slides): export the file to PDF, read the ACTUAL pagination, and flag layout issues the structural QC can't see — a heading stranded at a page bottom (orphan). Returns pageCount + findings. Defaults to the SA identity.",
    inputSchema: z.object({ fileId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const drive = new DriveService(env, account);
      const pages = await pdfToPages(await drive.exportBinary(a.fileId, "application/pdf"));

      let headings: string[] = [];
      try {
        const meta = await drive.get(a.fileId);
        if ((meta.mimeType ?? "").includes("document")) {
          headings = collectHeadings(await new DocsService(env, account).getRaw(a.fileId));
        }
      } catch {
        // non-Docs or no heading access → pagination-only report
      }
      return { result: { pageCount: pages.length, findings: analyzePages(pages, headings) } };
    },
  },
  {
    name: "appsscript_deploy",
    description:
      "Deploy an Apps Script project: snapshot an immutable version, then create a deployment (API-executable and/or web app, per its manifest). Returns deploymentId + any web-app URL. The web-app path is the headless-execution route (a service account can hit the URL); container-bound web apps let a Doc/Sheet call back into this worker. Defaults to the SA identity.",
    inputSchema: z.object({ scriptId: z.string(), description: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const svc = new AppsScriptService(env, a.as_user ? acct(sub, a) : "sa");
      const version = await svc.createVersion(a.scriptId, a.description);
      const dep = await svc.createDeployment(a.scriptId, version.versionNumber, a.description);
      const webAppUrl = ((dep.entryPoints as any[]) ?? []).map((e) => e?.webApp?.url).find(Boolean) ?? null;
      return {
        result: { versionNumber: version.versionNumber, deploymentId: dep.deploymentId, webAppUrl, entryPoints: dep.entryPoints },
        asset: { assetType: "script", googleId: a.scriptId, action: "modify", detail: { deploymentId: dep.deploymentId } },
      };
    },
  },
  {
    name: "appsscript_list_deployments",
    description: "List an Apps Script project's deployments (with entry points / web-app URLs).",
    inputSchema: z.object({ scriptId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      return { result: await new AppsScriptService(env, a.as_user ? acct(sub, a) : "sa").listDeployments(a.scriptId) };
    },
  },
  {
    name: "appscript_deploy_code",
    description:
      "Push agent-authored code to a standing Apps Script project and make it runnable: reads the project (preserving the manifest + existing files), merges the new/modified files by name, snapshots an immutable version, and re-points the standing (API-executable) deployment at it — then logs the deployment to D1 for audit/rollback. Omit scriptId to use the acting account's standing project. Namespace file names by use case (e.g. 'UseCaseA_Helper') so extensions don't clobber each other. Execute afterwards with appscript_run. Set createNew:true to mint a fresh deployment instead of updating the standing one.",
    inputSchema: z.object({
      useCase: z.string().describe("Short label for this deployment (audit + version description)."),
      newFiles: z
        .array(
          z.object({
            name: z.string(),
            type: z.enum(["SERVER_JS", "HTML", "JSON"]),
            source: z.string(),
          }),
        )
        .min(1)
        .describe("New or modified files. Use the manifest name 'appsscript' (type JSON) only to change the manifest."),
      scriptId: z.string().optional().describe("Target project. Omit to use the acting account's standing script."),
      description: z.string().optional(),
      deploymentId: z.string().optional().describe("Deployment to update. Omit to use the cached/discovered standing deployment."),
      createNew: z.boolean().optional().describe("Create a brand-new deployment instead of updating the standing one."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const accountKey = a.as_user ?? sub;
      const scriptId = a.scriptId ?? (await resolveStandingScript(env, accountKey));
      if (!scriptId) {
        throw new Error(`No scriptId given and no standing Apps Script registered for ${accountKey}. Pass scriptId or call appscript_register_standing.`);
      }
      const result = await deployMergedVersion(env, acct(sub, a), {
        scriptId,
        newFiles: a.newFiles,
        useCase: a.useCase,
        description: a.description,
        deploymentId: a.deploymentId,
        createNew: a.createNew,
        account: accountKey,
      });
      return { result, asset: { assetType: "script", googleId: scriptId, action: "modify", detail: { versionNumber: result.versionNumber, deploymentId: result.deploymentId } } };
    },
  },
  {
    name: "appscript_rollback",
    description:
      "Roll a standing Apps Script deployment back to an earlier version by re-pointing it — no recompile. Use appscript_deploy_history to find the target versionNumber. Omit scriptId to use the acting account's standing project.",
    inputSchema: z.object({
      versionNumber: z.number().int().min(1),
      scriptId: z.string().optional(),
      deploymentId: z.string().optional(),
      description: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const accountKey = a.as_user ?? sub;
      const scriptId = a.scriptId ?? (await resolveStandingScript(env, accountKey));
      if (!scriptId) throw new Error(`No scriptId given and no standing Apps Script registered for ${accountKey}.`);
      const result = await rollbackDeployment(env, acct(sub, a), {
        scriptId,
        versionNumber: a.versionNumber,
        deploymentId: a.deploymentId,
        description: a.description,
        account: accountKey,
      });
      return { result, asset: { assetType: "script", googleId: scriptId, action: "modify", detail: { rollbackTo: a.versionNumber } } };
    },
  },
  {
    name: "appscript_deploy_history",
    description: "List the D1 deployment/rollback audit log for an Apps Script project (newest version first), for reviewing past variants and picking a rollback target. Omit scriptId to use the acting account's standing project.",
    inputSchema: z.object({ scriptId: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const accountKey = a.as_user ?? sub;
      const scriptId = a.scriptId ?? (await resolveStandingScript(env, accountKey));
      if (!scriptId) throw new Error(`No scriptId given and no standing Apps Script registered for ${accountKey}.`);
      return { result: { scriptId, history: await deploymentHistory(env, scriptId) } };
    },
  },
  {
    name: "appscript_register_standing",
    description: "Register (or override) the standing Apps Script project — and optionally its deployment id — for an account, so appscript_deploy_code/rollback can be called without a scriptId. Defaults the account to the acting identity.",
    inputSchema: z.object({ scriptId: z.string(), deploymentId: z.string().optional(), account: z.string().email().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const accountKey = a.account ?? a.as_user ?? sub;
      await setStandingScript(env, accountKey, a.scriptId, a.deploymentId);
      return { result: { ok: true, account: accountKey, scriptId: a.scriptId, deploymentId: a.deploymentId ?? null } };
    },
  },
  {
    name: "appscript_scaffold",
    description:
      "Overwrite an Apps Script project with a ready-to-use container-bound template: 'sidebar' (custom menu + sidebar shell) or 'chat-sidebar' (chat UI that calls the worker's /api/appscript/ai bridge). After: set Script Properties WORKER_URL + WORKER_KEY, then appsscript_deploy. Defaults to the SA identity.",
    inputSchema: z.object({ scriptId: z.string(), template: z.enum(["sidebar", "chat-sidebar"]), ...asUser }),
    async run({ env, sub }, a) {
      const files = SCRIPT_SCAFFOLDS[a.template];
      await new AppsScriptService(env, a.as_user ? acct(sub, a) : "sa").updateContent(a.scriptId, files);
      return { result: { scriptId: a.scriptId, template: a.template, files: files.map((f) => f.name) } };
    },
  },
  {
    name: "appscript_save_roll",
    description: "Save an Apps Script project's current files as a reusable 'roll' in the braille registry (surface=appscript) for replay into other projects.",
    inputSchema: z.object({ scriptId: z.string(), name: z.string(), tags: z.array(z.string()).optional(), ...asUser }),
    async run({ env, sub }, a) {
      const content = await new AppsScriptService(env, a.as_user ? acct(sub, a) : "sa").getContent(a.scriptId);
      const id = crypto.randomUUID();
      await getDb(env).insert(brailleArtifacts).values({
        id,
        sourceFileId: a.scriptId,
        sourceUrl: null,
        surface: "appscript",
        kind: "template",
        name: a.name,
        anchor: null,
        structure: content as Record<string, unknown>,
        tags: a.tags ?? null,
        createdBySub: sub,
        createdAt: new Date(),
      });
      return { result: { id, name: a.name } };
    },
  },
  {
    name: "appscript_apply_roll",
    description: "Apply a saved Apps Script roll (braille id) to a project — overwrites its files with the roll's.",
    inputSchema: z.object({ rollId: z.string(), scriptId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const row = (await getDb(env).select().from(brailleArtifacts).where(eq(brailleArtifacts.id, a.rollId)).limit(1))[0];
      if (!row) throw new Error(`No roll with id ${a.rollId}`);
      const files = (row.structure as { files?: unknown[] })?.files;
      if (!Array.isArray(files)) throw new Error("Roll has no files[] to apply.");
      await new AppsScriptService(env, a.as_user ? acct(sub, a) : "sa").updateContent(a.scriptId, files);
      return { result: { scriptId: a.scriptId, applied: row.name, files: files.length } };
    },
  },
  {
    name: "vision_qc",
    description:
      "Pixel-level QC. For Slides: render each slide to a thumbnail and ask a vision model to flag layout problems (overflow, crowding, tiny/low-contrast text, misalignment). For Docs/Sheets: pixel vision needs a rasterizer, so it falls back to render_qc pagination. Defaults to the SA identity.",
    inputSchema: z.object({ fileId: z.string(), prompt: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const drive = new DriveService(env, account);
      const mime = (await drive.get(a.fileId)).mimeType ?? "";

      if (mime.includes("presentation")) {
        const slides = new SlidesService(env, account);
        const deck = (await slides.get(a.fileId)) as { slides?: { objectId?: string }[] };
        const prompt = a.prompt ?? "You are a slide design reviewer. List concrete layout problems: text overflow/cutoff, crowding, tiny or low-contrast text, misaligned or overlapping elements, awkward empty space. If clean, say 'clean'. Be terse.";
        const findings: unknown[] = [];
        for (const [i, s] of (deck.slides ?? []).slice(0, 10).entries()) {
          if (!s.objectId) continue;
          try {
            const thumb = (await slides.getThumbnail(a.fileId, s.objectId)) as { contentUrl?: string };
            if (!thumb.contentUrl) continue;
            const img = new Uint8Array(await (await fetch(thumb.contentUrl)).arrayBuffer());
            const out = (await (env.AI as any).run("@cf/meta/llama-3.2-11b-vision-instruct", { image: Array.from(img), prompt })) as { response?: string; description?: string };
            findings.push({ slide: i + 1, notes: out?.response ?? out?.description ?? "" });
          } catch (err) {
            findings.push({ slide: i + 1, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { result: { surface: "slide", slidesReviewed: findings.length, findings } };
      }

      const surface = mime.includes("spreadsheet") ? "sheet" : "doc";
      const pdf = await drive.exportBinary(a.fileId, "application/pdf");

      // Pixel vision: rasterize the PDF via Browser Rendering, then review it.
      const png = await rasterizePdf(env, pdf);
      if (png) {
        const stored = await storeRender(env, png, { sourceFileId: a.fileId, sub });
        const prompt = a.prompt ?? "You are a document layout reviewer. The image shows the rendered pages top-to-bottom. List concrete layout problems: a table split across two pages that could fit one, a heading stranded at a page bottom, squished or overflowing tables, awkward text wrapping, uneven spacing. If it looks clean, say 'clean'. Be terse.";
        const out = (await (env.AI as any).run("@cf/meta/llama-3.2-11b-vision-instruct", { image: Array.from(png), prompt })) as { response?: string; description?: string };
        return { result: { surface, method: "browser-render + vision", screenshotUrl: stored.url, findings: [{ notes: out?.response ?? out?.description ?? "" }] } };
      }

      // Fallback: no rasterizer available → render_qc pagination.
      const pages = await pdfToPages(pdf);
      let headings: string[] = [];
      if (mime.includes("document")) {
        try { headings = collectHeadings(await new DocsService(env, account).getRaw(a.fileId)); } catch { /* no heading access */ }
      }
      return {
        result: {
          surface,
          method: "pagination-fallback",
          note: "Browser Rendering unavailable (enable it, or check the API token) — ran render_qc pagination instead.",
          pageCount: pages.length,
          findings: analyzePages(pages, headings),
        },
      };
    },
  },
  // ---- Scratch sandbox ---------------------------------------------------
  {
    name: "create_scratch_doc",
    description:
      "Create a Google Doc in the dedicated 'MCP Scratch' folder, stamped as work-product/design-scratch, and return its link. A safe sandbox for building a sample for approval before producing the real document. Defaults to the SA identity.",
    inputSchema: z.object({ title: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const drive = new DriveService(env, account);
      const folderId = await drive.findOrCreateFolder("MCP Scratch");
      const docs = new DocsService(env, account);
      const doc = await docs.create(a.title ?? "Scratch Doc");
      await docs.insertText(doc.documentId, "⚠️  WORK PRODUCT — DESIGN SCRATCH · not a final document\n\n", 1);
      await drive.updateFile(doc.documentId, { addParents: folderId });
      const url = `https://docs.google.com/document/d/${doc.documentId}/edit`;
      return { result: { documentId: doc.documentId, url, folderId }, asset: { assetType: "doc", googleId: doc.documentId, title: doc.title, url, action: "create", detail: { scratch: true } } };
    },
  },
  {
    name: "create_scratch_sheet",
    description: "Create a Google Sheet in the 'MCP Scratch' folder and return its link. Sandbox for sample spreadsheets. Defaults to the SA identity.",
    inputSchema: z.object({ title: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const drive = new DriveService(env, account);
      const folderId = await drive.findOrCreateFolder("MCP Scratch");
      const sheet = await new SheetsService(env, account).create(a.title ?? "Scratch Sheet");
      await drive.updateFile(sheet.spreadsheetId, { addParents: folderId });
      const url = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`;
      return { result: { spreadsheetId: sheet.spreadsheetId, url, folderId }, asset: { assetType: "sheet", googleId: sheet.spreadsheetId, url, action: "create", detail: { scratch: true } } };
    },
  },
  {
    name: "create_scratch_slides",
    description: "Create a Google Slides deck in the 'MCP Scratch' folder and return its link. Sandbox for sample decks. Defaults to the SA identity.",
    inputSchema: z.object({ title: z.string().optional(), ...asUser }),
    async run({ env, sub }, a) {
      const account = a.as_user ? acct(sub, a) : "sa";
      const drive = new DriveService(env, account);
      const folderId = await drive.findOrCreateFolder("MCP Scratch");
      const deck = await new SlidesService(env, account).create(a.title ?? "Scratch Deck");
      await drive.updateFile(deck.presentationId, { addParents: folderId });
      const url = `https://docs.google.com/presentation/d/${deck.presentationId}/edit`;
      return { result: { presentationId: deck.presentationId, url, folderId }, asset: { assetType: "slide", googleId: deck.presentationId, url, action: "create", detail: { scratch: true } } };
    },
  },
  // ---- Gmail label registry ---------------------------------------------
  {
    name: "gmail_labels_sync",
    description:
      "Reconcile the D1 gmail_labels registry with live Gmail across ALL active accounts (or one, via `account`): register new labels, reactivate returned ones, soft-delete (is_active=0) labels gone from Gmail. Runs weekly via cron; call to sync on demand.",
    inputSchema: z.object({ account: z.string().email().optional() }),
    async run({ env }, a) {
      if (a.account) {
        const target = (await listCaptureAccounts(env)).find((x) => x.email === a.account!.toLowerCase());
        if (!target) throw new Error(`Account ${a.account} is not active/available.`);
        return { result: { synced: [await syncLabels(env, target.ref, target.email)] } };
      }
      return { result: { synced: await syncLabelsForAllAccounts(env) } };
    },
  },
  {
    name: "gmail_labels_list",
    description:
      "List labels from the D1 registry (not live Gmail), across all accounts or one via `account`. Filter by active state and/or capture mode. Includes per-label capture config.",
    inputSchema: z.object({
      account: z.string().email().optional(),
      activeOnly: z.boolean().optional(),
      captureMode: z.enum(["none", "metadata", "vectorize"]).optional(),
    }),
    async run({ env }, a) {
      const db = getDb(env);
      const conds = [];
      if (a.account) conds.push(eq(gmailLabels.account, a.account.toLowerCase()));
      if (a.activeOnly !== false) conds.push(eq(gmailLabels.isActive, true));
      if (a.captureMode) conds.push(eq(gmailLabels.captureMode, a.captureMode));
      const base = db.select().from(gmailLabels);
      const rows = await (conds.length ? base.where(and(...conds)) : base).orderBy(gmailLabels.name);
      return { result: { labels: rows } };
    },
  },
  {
    name: "gmail_label_create",
    description:
      "Create a Gmail label on an account (optionally nested under parentId and/or auto-applied by a filter), and register it in D1. `account` selects which registered account (defaults to the first active); `filter` is Gmail filter criteria, e.g. { from: 'a@b.com' } or { query: 'has:attachment' }.",
    inputSchema: z.object({
      name: z.string(),
      account: z.string().email().optional(),
      parentId: z.string().optional(),
      description: z.string().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
    }),
    async run({ env }, a) {
      const db = getDb(env);
      const accounts = await listCaptureAccounts(env);
      const target = a.account ? accounts.find((x) => x.email === a.account!.toLowerCase()) : accounts[0];
      if (!target) throw new Error(`Account ${a.account ?? "(default)"} not active. Available: ${accounts.map((x) => x.email).join(", ") || "none"}.`);

      let fullName = a.name;
      if (a.parentId) {
        const parent = await db.select({ name: gmailLabels.name }).from(gmailLabels).where(eq(gmailLabels.id, a.parentId)).limit(1);
        if (!parent[0]) throw new Error(`No registered label with id ${a.parentId} to nest under. Run gmail_labels_sync first.`);
        fullName = `${parent[0].name}/${a.name}`;
      }

      const gmail = new GmailService(env, target.ref);
      const label = await gmail.createLabel(fullName);
      let filterCriteria: Record<string, unknown> | undefined;
      if (a.filter) {
        await gmail.createFilter(a.filter, label.id);
        filterCriteria = a.filter;
      }

      const now = new Date();
      await db.insert(gmailLabels).values({
        id: label.id,
        account: target.email,
        name: fullName,
        parentId: a.parentId ?? null,
        description: a.description ?? null,
        isActive: true,
        createdVia: "worker",
        filtersJson: filterCriteria ? [filterCriteria] : null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        result: { id: label.id, name: fullName, parentId: a.parentId ?? null, filter: filterCriteria ?? null },
        asset: { assetType: "gmail-label", googleId: label.id, title: fullName, action: "create" },
      };
    },
  },
  {
    name: "gmail_label_set_capture",
    description:
      "Configure how a label's messages are captured. captureMode: none | metadata | vectorize. captureAttachments + attachmentStore (r2|drive) + attachmentDriveFolderId control attachment handling. Only labels with captureMode != none are ingested.",
    inputSchema: z.object({
      labelId: z.string(),
      captureMode: z.enum(["none", "metadata", "vectorize"]).optional(),
      captureAttachments: z.boolean().optional(),
      attachmentStore: z.enum(["r2", "drive"]).optional(),
      attachmentDriveFolderId: z.string().optional(),
      description: z.string().optional(),
    }),
    async run({ env }, a) {
      const db = getDb(env);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (a.captureMode !== undefined) patch.captureMode = a.captureMode;
      if (a.captureAttachments !== undefined) patch.captureAttachments = a.captureAttachments;
      if (a.attachmentStore !== undefined) patch.attachmentStore = a.attachmentStore;
      if (a.attachmentDriveFolderId !== undefined) patch.attachmentDriveFolderId = a.attachmentDriveFolderId;
      if (a.description !== undefined) patch.description = a.description;
      await db.update(gmailLabels).set(patch).where(eq(gmailLabels.id, a.labelId));
      const row = await db.select().from(gmailLabels).where(eq(gmailLabels.id, a.labelId)).limit(1);
      return { result: { label: row[0] ?? null } };
    },
  },
  {
    name: "gmail_capture_run",
    description:
      "Ingest messages for capture-enabled labels (captureMode != none) into the relational store: gmail_threads, gmail_messages, gmail_message_bodies, gmail_message_contacts (from/to/cc/bcc). Runs weekly via cron after label sync; call to ingest on demand. Idempotent — already-stored messages are skipped. All active accounts, or one via `account`.",
    inputSchema: z.object({
      account: z.string().email().optional(),
      perLabel: z.number().int().min(1).max(100).optional(),
    }),
    async run({ env }, a) {
      if (a.account) {
        const target = (await listCaptureAccounts(env)).find((x) => x.email === a.account!.toLowerCase());
        if (!target) throw new Error(`Account ${a.account} is not active/available.`);
        return { result: { captured: [await captureAccount(env, target.ref, target.email, a.perLabel ?? 25)] } };
      }
      return { result: { captured: await captureAllAccounts(env) } };
    },
  },
  {
    name: "gmail_rag_search",
    description:
      "Semantic search over captured mail (labels set to captureMode=vectorize). Returns the best-matching messages with subject, sender, snippet, and a matched-text preview. Optionally scope to one account.",
    inputSchema: z.object({
      query: z.string(),
      account: z.string().email().optional(),
      topK: z.number().int().min(1).max(25).optional(),
    }),
    async run({ env }, a) {
      return { result: { hits: await searchGmail(env, a.query, { account: a.account, topK: a.topK }) } };
    },
  },
  // ---- Code mode (search + execute — the entire toolset in ~1k tokens) ---
  {
    name: "code_mode_search",
    description:
      "DISCOVER tools without loading the whole catalog into context. Write a JS async function body; `codemode.tools()` returns the full array of { name, description, inputSchema } for every Workspace tool. Filter/map it and RETURN only what you need — only your return value enters context, never the whole catalog. " +
      "Example: `const all = codemode.tools(); return all.filter(t => /gmail|draft/.test(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));`. " +
      "Then run the tools you found with code_mode_run. Search is read-only: no tool execution, no network.",
    inputSchema: z.object({
      code: z.string().describe("JS function body. Use `codemode.tools()` to read the catalog and `return` the filtered subset you need."),
    }),
    outputSchema: codeModeResultSchema,
    async run({ env }, a) {
      return { result: await runCodeModeSearch(env, a.code) };
    },
  },
  {
    name: "code_mode_run",
    description:
      "EXECUTE a JavaScript snippet in an isolated sandbox (no network, no secrets) that can call any Workspace tool via `await tools.<name>(args)`. Discover tool names + arg schemas first with code_mode_search. Chain many calls, transform results, and `return` a final value; use console.log for debug output. Prefer this over many sequential tool calls when orchestrating multi-step work.",
    inputSchema: z.object({
      code: z.string().describe("JavaScript function body. Use `await tools.<name>({...})`, `console.log(...)`, and `return <value>`."),
      cpuMs: z.number().int().min(1000).max(300000).optional().describe("CPU time budget for the sandbox (default 30000)."),
      subRequests: z.number().int().min(1).max(1000).optional().describe("Subrequest budget for the sandbox (default 50)."),
    }),
    outputSchema: codeModeResultSchema,
    async run({ env, sub }, a) {
      return { result: await runCodeMode(env, sub, a.code, { cpuMs: a.cpuMs, subRequests: a.subRequests }) };
    },
  },
  // ---- Diagnostics -------------------------------------------------------
  {
    name: "accounts_health_check",
    description:
      "Health-check every configured Google account by making a cheap read call against each Workspace service (Gmail, Drive, Calendar, Contacts, Apps Script). Returns per-account, per-service ok/fail with latency and error messages, plus a summary of how many accounts are fully working. Use to verify which accounts are connected and online. Docs/Sheets/Slides/Forms share Drive's OAuth scope, so a passing Drive check covers their file access too.",
    inputSchema: z.object({}),
    async run({ env }) {
      const accounts = await listCaptureAccounts(env);
      // Cheap, id-free read per service (each exercises that service's scope).
      const probes: { service: string; run: (ref: string) => Promise<unknown> }[] = [
        { service: "gmail", run: (r) => new GmailService(env, r).getProfile() },
        { service: "drive", run: (r) => new DriveService(env, r).getStorageFree() },
        { service: "calendar", run: (r) => new CalendarService(env, r).listCalendars() },
        { service: "contacts", run: (r) => new PeopleService(env, r).getContact("people/me", "names") },
        { service: "appsscript", run: (r) => new AppsScriptService(env, r).listProcesses() },
      ];
      // ponytail: probe accounts sequentially, services parallel within each,
      // so at most `probes.length` (5) subrequests are ever in flight — bounded
      // regardless of account count, well clear of the Workers subrequest cap.
      const results: {
        email: string;
        online: boolean;
        fullyWorking: boolean;
        okCount: number;
        serviceCount: number;
        services: { service: string; status: "ok" | "fail"; latencyMs: number; error?: string }[];
      }[] = [];
      for (const { email, ref } of accounts) {
        const services = await Promise.all(
          probes.map(async ({ service, run }) => {
            const t = Date.now();
            try {
              await run(ref);
              return { service, status: "ok" as const, latencyMs: Date.now() - t };
            } catch (e) {
              return {
                service,
                status: "fail" as const,
                latencyMs: Date.now() - t,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          }),
        );
        const okCount = services.filter((s) => s.status === "ok").length;
        results.push({
          email,
          online: okCount > 0,
          fullyWorking: okCount === services.length,
          okCount,
          serviceCount: services.length,
          services,
        });
      }
      const working = results.filter((a) => a.fullyWorking).length;
      return {
        result: {
          checkedAt: new Date().toISOString(),
          accountCount: results.length,
          fullyWorkingAccounts: working,
          summary:
            results.length === 0
              ? "No Google accounts are registered/connected."
              : `${working}/${results.length} account(s) fully working across all probed services.`,
          accounts: results,
          note: "Probed services: gmail, drive, calendar, contacts, appsscript. Docs/Sheets/Slides/Forms use the same Drive OAuth scope, so a passing 'drive' check indicates their file access works too.",
        },
      };
    },
  },
];

/**
 * The public MCP surface is intentionally **code-mode-only** — only these two
 * tools are advertised over `/mcp` (tools/list + tools/call), so the client's
 * tool-catalog token footprint stays ~constant (~1k tokens) regardless of how
 * many tools exist (Cloudflare's search+execute Code Mode pattern). The full
 * {@link TOOLS} list is discovered on demand INSIDE the sandbox: `code_mode_search`
 * filters the catalog (only the subset returns to context) and `code_mode_run`
 * executes `await tools.<name>(args)` (routed through `GsuiteService.callTool`).
 * Both exposed tools declare an `outputSchema`.
 */
export const MCP_EXPOSED_TOOLS: ToolDef[] = TOOLS.filter(
  (tool) => tool.name === "code_mode_search" || tool.name === "code_mode_run",
);
