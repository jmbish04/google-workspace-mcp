/**
 * @file src/backend/pdf/service.ts
 * @description Core service layer for pdfme rendering, template CRUD,
 * seeding built-in templates, and converting historical generation logs into
 * repeatable templates.
 */
import { generate } from "@pdfme/generator";
import { and, desc, eq, like, or } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@/backend/db/schema";
import { pdfGenerationLogs, pdfTemplates, type PdfGenerationLog, type PdfTemplate } from "@/backend/db/schema";
import { pdfmePlugins } from "./plugins";
import { BUILTIN_TEMPLATES } from "./templates/builtin";
import type { PdfmeTemplateDefinition, RenderPdfOptions, RenderPdfResult } from "./types";

/**
 * Render a PDF document from a pdfme template definition and input variables.
 */
export async function renderPdfBuffer(options: RenderPdfOptions): Promise<RenderPdfResult> {
  const { template, inputs } = options;

  // Render via @pdfme/generator
  const pdfBytes = await generate({
    template: template as any,
    inputs: inputs.length > 0 ? inputs : [{}],
    plugins: pdfmePlugins as any,
  });

  const byteSize = pdfBytes.byteLength;
  const pageCount = Array.isArray(template.schemas) ? template.schemas.length : 1;

  return {
    pdfBytes,
    byteSize,
    pageCount,
  };
}

/**
 * Idempotently seed or update the 7 built-in templates into D1.
 */
export async function seedBuiltinTemplates(d1: D1Database): Promise<{ count: number; ids: string[] }> {
  const db = drizzle(d1, { schema });
  const ids: string[] = [];

  for (const t of BUILTIN_TEMPLATES) {
    const existing = await db
      .select({ id: pdfTemplates.id })
      .from(pdfTemplates)
      .where(eq(pdfTemplates.id, t.id))
      .get();

    const row = {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      schemaJson: JSON.stringify(t.schema),
      sampleDataJson: JSON.stringify(t.sampleData),
      thumbnailUrl: t.thumbnailUrl ?? null,
      isBuiltin: true,
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(pdfTemplates).set(row).where(eq(pdfTemplates.id, t.id)).run();
    } else {
      await db.insert(pdfTemplates).values({ ...row, createdAt: new Date() }).run();
    }
    ids.push(t.id);
  }

  return { count: ids.length, ids };
}

/**
 * List templates with optional category filter and keyword search.
 */
export async function listPdfTemplates(
  d1: D1Database,
  options?: { category?: string; search?: string }
): Promise<PdfTemplate[]> {
  const db = drizzle(d1, { schema });
  const conditions = [];

  if (options?.category && options.category !== "all") {
    conditions.push(eq(pdfTemplates.category, options.category));
  }

  if (options?.search?.trim()) {
    const term = `%${options.search.trim()}%`;
    conditions.push(
      or(
        like(pdfTemplates.name, term),
        like(pdfTemplates.description, term),
        like(pdfTemplates.category, term)
      )
    );
  }

  const query = db
    .select()
    .from(pdfTemplates)
    .orderBy(desc(pdfTemplates.isBuiltin), desc(pdfTemplates.createdAt));

  if (conditions.length > 0) {
    return query.where(and(...conditions)).all();
  }

  return query.all();
}

/**
 * Get a single PDF template by ID.
 */
export async function getPdfTemplate(d1: D1Database, templateId: string): Promise<PdfTemplate | null> {
  const db = drizzle(d1, { schema });
  const item = await db
    .select()
    .from(pdfTemplates)
    .where(eq(pdfTemplates.id, templateId))
    .get();

  return item ?? null;
}

/**
 * Create a new custom PDF template.
 */
export async function createPdfTemplate(
  d1: D1Database,
  data: {
    id?: string;
    name: string;
    description?: string;
    category?: string;
    schema: PdfmeTemplateDefinition | string;
    sampleData?: Record<string, any>[] | string;
    thumbnailUrl?: string;
    createdBy?: string;
  }
): Promise<PdfTemplate> {
  const db = drizzle(d1, { schema });
  const id = data.id || `tmpl_custom_${crypto.randomUUID().slice(0, 8)}`;
  const schemaJson = typeof data.schema === "string" ? data.schema : JSON.stringify(data.schema);
  const sampleDataJson = data.sampleData
    ? typeof data.sampleData === "string"
      ? data.sampleData
      : JSON.stringify(data.sampleData)
    : null;

  const now = new Date();
  const newRow = {
    id,
    name: data.name,
    description: data.description ?? null,
    category: data.category || "custom",
    schemaJson,
    sampleDataJson,
    thumbnailUrl: data.thumbnailUrl ?? null,
    isBuiltin: false,
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(pdfTemplates).values(newRow).run();
  const created = await getPdfTemplate(d1, id);
  if (!created) throw new Error(`Failed to create template ${id}`);
  return created;
}

/**
 * Update an existing template.
 */
export async function updatePdfTemplate(
  d1: D1Database,
  id: string,
  data: {
    name?: string;
    description?: string;
    category?: string;
    schema?: PdfmeTemplateDefinition | string;
    sampleData?: Record<string, any>[] | string;
    thumbnailUrl?: string;
  }
): Promise<PdfTemplate> {
  const db = drizzle(d1, { schema });
  const existing = await getPdfTemplate(d1, id);
  if (!existing) throw new Error(`Template not found: ${id}`);

  const updateSet: Partial<typeof pdfTemplates.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updateSet.name = data.name;
  if (data.description !== undefined) updateSet.description = data.description;
  if (data.category !== undefined) updateSet.category = data.category;
  if (data.thumbnailUrl !== undefined) updateSet.thumbnailUrl = data.thumbnailUrl;
  if (data.schema !== undefined) {
    updateSet.schemaJson = typeof data.schema === "string" ? data.schema : JSON.stringify(data.schema);
  }
  if (data.sampleData !== undefined) {
    updateSet.sampleDataJson =
      typeof data.sampleData === "string" ? data.sampleData : JSON.stringify(data.sampleData);
  }

  await db.update(pdfTemplates).set(updateSet).where(eq(pdfTemplates.id, id)).run();
  const updated = await getPdfTemplate(d1, id);
  return updated!;
}

/**
 * Delete a template (protects built-in system templates).
 */
export async function deletePdfTemplate(d1: D1Database, id: string): Promise<boolean> {
  const db = drizzle(d1, { schema });
  const existing = await getPdfTemplate(d1, id);
  if (!existing) return false;
  if (existing.isBuiltin) {
    throw new Error(`Cannot delete built-in template ${id}`);
  }

  await db.delete(pdfTemplates).where(eq(pdfTemplates.id, id)).run();
  return true;
}

/**
 * List PDF generation logs.
 */
export async function listPdfGenerationLogs(
  d1: D1Database,
  options?: { limit?: number; offset?: number; search?: string }
): Promise<PdfGenerationLog[]> {
  const db = drizzle(d1, { schema });
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const query = db
    .select()
    .from(pdfGenerationLogs)
    .orderBy(desc(pdfGenerationLogs.createdAt))
    .limit(limit)
    .offset(offset);

  if (options?.search?.trim()) {
    const term = `%${options.search.trim()}%`;
    return query
      .where(
        or(
          like(pdfGenerationLogs.title, term),
          like(pdfGenerationLogs.driveFolderName, term),
          like(pdfGenerationLogs.driveAccountEmail, term)
        )
      )
      .all();
  }

  return query.all();
}

/**
 * Get one PDF generation log by ID.
 */
export async function getPdfGenerationLog(d1: D1Database, id: string): Promise<PdfGenerationLog | null> {
  const db = drizzle(d1, { schema });
  const log = await db
    .select()
    .from(pdfGenerationLogs)
    .where(eq(pdfGenerationLogs.id, id))
    .get();

  return log ?? null;
}

/**
 * Get one PDF generation log by its secure worker view token.
 */
export async function getPdfGenerationLogByToken(
  d1: D1Database,
  token: string
): Promise<PdfGenerationLog | null> {
  const db = drizzle(d1, { schema });
  const log = await db
    .select()
    .from(pdfGenerationLogs)
    .where(eq(pdfGenerationLogs.workerViewToken, token))
    .get();

  return log ?? null;
}

/**
 * Convert a historical PDF generation log into a repeatable template.
 */
export async function convertLogToTemplate(
  d1: D1Database,
  options: {
    logId: string;
    name: string;
    description?: string;
    category?: string;
  }
): Promise<PdfTemplate> {
  const db = drizzle(d1, { schema });
  const log = await getPdfGenerationLog(d1, options.logId);
  if (!log) throw new Error(`Generation log not found: ${options.logId}`);

  let schemaJson = log.schemaSnapshotJson;

  // Fallback to parent template if snapshot wasn't stored
  if (!schemaJson && log.templateId) {
    const parentTmpl = await getPdfTemplate(d1, log.templateId);
    if (parentTmpl) schemaJson = parentTmpl.schemaJson;
  }

  if (!schemaJson) {
    throw new Error(`Log ${options.logId} does not contain a recoverable schema snapshot`);
  }

  const newTemplate = await createPdfTemplate(d1, {
    name: options.name,
    description: options.description || `Derived from created PDF "${log.title}"`,
    category: options.category || "custom",
    schema: schemaJson,
    sampleData: log.inputDataJson,
    createdBy: log.createdBy ?? "system",
  });

  return newTemplate;
}
