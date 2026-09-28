/**
 * @file src/backend/api/routes/pdf.ts
 * @description Comprehensive REST API for PDF generation, template studio CRUD,
 * generation audit logs, D1 log-to-template conversion, R2 & Drive storage,
 * locked-down view tokens, and email delivery.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppBindings } from "../index";
import {
  convertLogToTemplate,
  createPdfTemplate,
  deletePdfTemplate,
  getPdfGenerationLog,
  getPdfGenerationLogByToken,
  getPdfTemplate,
  listPdfGenerationLogs,
  listPdfTemplates,
  renderPdfBuffer,
  seedBuiltinTemplates,
  updatePdfTemplate,
} from "@/backend/pdf/service";
import {
  exportDriveFileToPdfInSameFolder,
  savePdfFullWorkflow,
  updateDriveSharing,
} from "@/backend/pdf/storage";
import { sendEmailWithAttachmentOrDriveLink } from "@/backend/pdf/delivery";
import type { PdfmeTemplateDefinition } from "@/backend/pdf/types";
import { agentAuthMiddleware } from "@/backend/api/middleware/agent-auth";

export const pdfRouter = new OpenAPIHono<AppBindings>();

// ---------------------------------------------------------------------------
// Security: Gate private audit, mutation, and distribution routes behind session/API key.
// The public recipient endpoints (/view/:token and /raw/:token) and read-only
// template discovery remain accessible.
// ---------------------------------------------------------------------------
pdfRouter.use("/logs", agentAuthMiddleware);
pdfRouter.use("/logs/*", agentAuthMiddleware);
pdfRouter.use("/render", agentAuthMiddleware);
pdfRouter.use("/drive-convert", agentAuthMiddleware);
pdfRouter.use("/sharing", agentAuthMiddleware);
pdfRouter.use("/email-send", agentAuthMiddleware);
pdfRouter.use("/r2/*", agentAuthMiddleware);

// ---------------------------------------------------------------------------
// Templates CRUD
// ---------------------------------------------------------------------------

/**
 * GET /templates — List all templates (auto-seeds built-ins on first run or ?seed=1).
 */
pdfRouter.get("/templates", async (c) => {
  const category = c.req.query("category");
  const search = c.req.query("search");
  const forceSeed = c.req.query("seed") === "1";

  if (forceSeed) {
    await seedBuiltinTemplates(c.env.DB);
  }

  let list = await listPdfTemplates(c.env.DB, { category, search });
  if (list.length === 0 && !category && !search) {
    // Auto-seed built-ins if empty
    await seedBuiltinTemplates(c.env.DB);
    list = await listPdfTemplates(c.env.DB);
  }

  return c.json({ templates: list });
});

/**
 * GET /templates/:id — Get one template with schema and sample inputs.
 */
pdfRouter.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const tmpl = await getPdfTemplate(c.env.DB, id);
  if (!tmpl) {
    return c.json({ error: "Template not found" }, 404);
  }
  return c.json(tmpl);
});

/**
 * POST /templates — Create a new custom template.
 */
pdfRouter.post("/templates", agentAuthMiddleware, async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().optional(),
    schema: z.union([z.string(), z.record(z.string(), z.any())]),
    sampleData: z.union([z.string(), z.array(z.record(z.string(), z.any()))]).optional(),
    thumbnailUrl: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid template payload", details: parsed.error.format() }, 400);
  }

  try {
    const created = await createPdfTemplate(c.env.DB, parsed.data as any);
    return c.json({ success: true, template: created }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed creating template" }, 500);
  }
});

/**
 * PUT /templates/:id — Update a custom template.
 */
pdfRouter.put("/templates/:id", agentAuthMiddleware, async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing template id" }, 400);
  const body = await c.req.json();
  try {
    const updated = await updatePdfTemplate(c.env.DB, id, body);
    return c.json({ success: true, template: updated });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed updating template" }, 500);
  }
});

/**
 * DELETE /templates/:id — Delete a custom template.
 */
pdfRouter.delete("/templates/:id", agentAuthMiddleware, async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing template id" }, 400);
  try {
    const ok = await deletePdfTemplate(c.env.DB, id);
    if (!ok) return c.json({ error: "Template not found" }, 404);
    return c.json({ success: true, id });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed deleting template" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Render & Generation Workflow
// ---------------------------------------------------------------------------

/**
 * POST /render — Render a PDF document.
 * Can return base64 JSON, binary stream, or coordinate R2 + Drive save.
 */
pdfRouter.post("/render", async (c) => {
  const body = await c.req.json();
  const renderSchema = z.object({
    templateId: z.string().optional(),
    template: z.custom<PdfmeTemplateDefinition>().optional(),
    inputs: z.array(z.record(z.string(), z.any())).default([{}]),
    title: z.string().optional(),
    filename: z.string().optional(),
    
    // Storage & sharing options
    saveRecord: z.boolean().default(true),
    saveToR2: z.boolean().default(true),
    saveToDrive: z.boolean().default(false),
    driveAccountRef: z.string().optional(),
    driveFolderId: z.string().optional(),
    driveFolderName: z.string().optional(),
    driveParentFolderId: z.string().optional(),
    driveSharingRole: z.enum(["restricted", "anyone-viewer", "anyone-commenter", "anyone-editor"]).optional(),
    workerViewMode: z.enum(["direct-worker", "drive-embed"]).default("direct-worker"),
    allowDownload: z.boolean().default(true),
  });

  const parsed = renderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid render options", details: parsed.error.format() }, 400);
  }

  const { data } = parsed;
  let targetTemplate: PdfmeTemplateDefinition | undefined = data.template;
  let templateTitle = data.title || "Generated Document";

  // Resolve template by ID if provided
  if (!targetTemplate && data.templateId) {
    const tmplRow = await getPdfTemplate(c.env.DB, data.templateId);
    if (!tmplRow) {
      return c.json({ error: `Template not found: ${data.templateId}` }, 404);
    }
    targetTemplate = JSON.parse(tmplRow.schemaJson);
    if (!data.title) templateTitle = tmplRow.name;
  }

  if (!targetTemplate) {
    return c.json({ error: "Must specify either templateId or template definition" }, 400);
  }

  try {
    const result = await renderPdfBuffer({
      template: targetTemplate,
      inputs: data.inputs,
    });

    let storedRecord = null;
    if (data.saveRecord) {
      storedRecord = await savePdfFullWorkflow(c.env, {
        title: templateTitle,
        filename: data.filename,
        pdfBytes: result.pdfBytes,
        templateId: data.templateId,
        inputData: data.inputs,
        schemaSnapshot: targetTemplate,
        saveToR2: data.saveToR2,
        saveToDrive: data.saveToDrive,
        driveAccountRef: data.driveAccountRef,
        driveFolderId: data.driveFolderId,
        driveFolderName: data.driveFolderName,
        driveParentFolderId: data.driveParentFolderId,
        driveSharingRole: data.driveSharingRole,
        workerViewMode: data.workerViewMode,
        allowDownload: data.allowDownload,
      });
    }

    // Convert bytes to base64
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < result.pdfBytes.length; i += chunk) {
      bin += String.fromCharCode(...result.pdfBytes.subarray(i, i + chunk));
    }
    const pdfBase64 = btoa(bin);

    return c.json({
      success: true,
      byteSize: result.byteSize,
      pageCount: result.pageCount,
      pdfBase64,
      record: storedRecord,
    });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed rendering PDF" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Generation Logs & Log-to-Template Conversion
// ---------------------------------------------------------------------------

/**
 * GET /logs — List historical PDF generation logs.
 */
pdfRouter.get("/logs", async (c) => {
  const search = c.req.query("search");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50;
  const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

  const logs = await listPdfGenerationLogs(c.env.DB, { search, limit, offset });
  return c.json({ logs });
});

/**
 * GET /logs/:id — Get a single PDF generation log.
 */
pdfRouter.get("/logs/:id", async (c) => {
  const id = c.req.param("id");
  const log = await getPdfGenerationLog(c.env.DB, id);
  if (!log) return c.json({ error: "Log not found" }, 404);
  return c.json(log);
});

/**
 * POST /logs/:id/convert-to-template — Convert historical PDF generation run into repeatable template.
 */
pdfRouter.post("/logs/:id/convert-to-template", async (c) => {
  const logId = c.req.param("id");
  const body = await c.req.json();
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid template metadata", details: parsed.error.format() }, 400);
  }

  try {
    const tmpl = await convertLogToTemplate(c.env.DB, {
      logId,
      name: parsed.data.name,
      description: parsed.data.description,
      category: parsed.data.category,
    });
    return c.json({ success: true, template: tmpl }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed converting log to template" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Locked-Down Worker View & Binary Stream
// ---------------------------------------------------------------------------

/**
 * GET /view/:token — Retrieve PDF view metadata for locked-down viewer.
 */
pdfRouter.get("/view/:token", async (c) => {
  const token = c.req.param("token");
  const log = await getPdfGenerationLogByToken(c.env.DB, token);
  if (!log) return c.json({ error: "Document not found or link has expired" }, 404);

  return c.json({
    id: log.id,
    title: log.title,
    byteSize: log.byteSize,
    pageCount: log.pageCount,
    workerViewMode: log.workerViewMode,
    allowDownload: log.allowDownload,
    driveUrl: log.driveUrl,
    r2ShareUrl: log.r2ShareUrl,
    rawStreamUrl: `/api/pdf/raw/${token}`,
    createdAt: log.createdAt,
  });
});

/**
 * GET /raw/:token — Stream raw PDF binary (direct stream from R2 or regenerated from log).
 */
pdfRouter.get("/raw/:token", async (c) => {
  const token = c.req.param("token");
  const isDownload = c.req.query("download") === "1";
  const log = await getPdfGenerationLogByToken(c.env.DB, token);
  if (!log) return c.text("Document not found", 404);

  if (isDownload && !log.allowDownload) {
    return c.text("Download is prohibited by sharing policy for this document", 403);
  }

  // 1. Try reading directly from R2 if key is stored
  if (log.r2Key && c.env.R2_FILES_BUCKET) {
    const obj = await c.env.R2_FILES_BUCKET.get(log.r2Key);
    if (obj) {
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("content-type", "application/pdf");
      if (isDownload) {
        headers.set("content-disposition", `attachment; filename="${log.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf"`);
      } else {
        headers.set("content-disposition", `inline; filename="${log.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf"`);
      }
      return new Response(obj.body, { headers });
    }
  }

  // 2. Regenerate from schema snapshot and input data
  if (log.schemaSnapshotJson) {
    try {
      const template = JSON.parse(log.schemaSnapshotJson);
      const inputs = JSON.parse(log.inputDataJson || "[]");
      const rendered = await renderPdfBuffer({ template, inputs });
      const headers = new Headers({
        "content-type": "application/pdf",
        "content-disposition": isDownload
          ? `attachment; filename="${log.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf"`
          : `inline; filename="${log.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf"`,
      });
      return new Response(rendered.pdfBytes as unknown as BodyInit, { headers });
    } catch (e) {
      console.warn("Could not regenerate PDF from log:", e);
    }
  }

  return c.text("PDF content could not be located", 404);
});

/**
 * GET /r2/:key — Direct stream from R2 files bucket (strictly restricted to pdfs/* objects).
 */
pdfRouter.get("/r2/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!key || !key.startsWith("pdfs/") || key.includes("..")) {
    return c.text("Forbidden: only pdfs/ objects may be accessed through this endpoint", 403);
  }
  if (!c.env.R2_FILES_BUCKET) return c.text("R2 bucket not bound", 500);

  const obj = await c.env.R2_FILES_BUCKET.get(key);
  if (!obj) return c.text("Object not found", 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-type", "application/pdf");
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// Google Drive Doc-to-PDF Conversion in Same Folder
// ---------------------------------------------------------------------------

/**
 * POST /drive-convert — Export any Google Doc/Sheet to PDF and save in same Drive folder.
 */
pdfRouter.post("/drive-convert", async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    sourceFileId: z.string().min(1),
    accountRef: z.string().optional(),
    sharingRole: z.enum(["restricted", "anyone-viewer", "anyone-commenter", "anyone-editor"]).optional(),
    newFileName: z.string().optional(),
    saveToR2Also: z.boolean().default(true),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid parameters", details: parsed.error.format() }, 400);
  }

  try {
    const record = await exportDriveFileToPdfInSameFolder(c.env, parsed.data);
    return c.json({ success: true, record }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed exporting Drive document to PDF" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Sharing Settings Mutation
// ---------------------------------------------------------------------------

/**
 * POST /sharing — View or update sharing permissions on Drive file/folder.
 */
pdfRouter.post("/sharing", async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    fileId: z.string().min(1),
    accountRef: z.string().optional(),
    role: z.enum(["reader", "commenter", "writer"]),
    type: z.enum(["anyone", "user", "domain"]),
    emailAddress: z.string().optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid sharing payload", details: parsed.error.format() }, 400);
  }

  try {
    const result = await updateDriveSharing(c.env, parsed.data);
    return c.json({ success: true, result });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed updating sharing settings" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Seamless Email Attachment & Drive Link Send
// ---------------------------------------------------------------------------

/**
 * POST /email-send — Direct path to attach PDF or Drive file to an email or insert share link.
 */
pdfRouter.post("/email-send", async (c) => {
  const body = await c.req.json();
  const schema = z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    bodyText: z.string().optional(),
    bodyHtml: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    accountRef: z.string().optional(),
    filename: z.string().optional(),
    pdfBase64: z.string().optional(),
    driveFileId: z.string().optional(),
    deliveryMode: z.enum(["mime-attachment", "drive-link", "both"]).default("mime-attachment"),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid email parameters", details: parsed.error.format() }, 400);
  }

  try {
    let pdfBytes: Uint8Array | undefined;
    if (parsed.data.pdfBase64) {
      const bin = atob(parsed.data.pdfBase64.replace(/\s/g, ""));
      pdfBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) pdfBytes[i] = bin.charCodeAt(i);
    }

    const result = await sendEmailWithAttachmentOrDriveLink(c.env, {
      ...parsed.data,
      pdfBytes,
    });

    return c.json({ success: true, result });
  } catch (err: any) {
    return c.json({ error: err.message || "Failed sending email with attachment" }, 500);
  }
});
