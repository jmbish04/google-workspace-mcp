/**
 * @file src/backend/pdf/storage.ts
 * @description Cloudflare R2 and Google Drive storage, folder management,
 * permission sharing, and D1 generation log recording for PDFs.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "@/backend/db/schema";
import { pdfGenerationLogs, type PdfGenerationLog } from "@/backend/db/schema";
import { GoogleDriveClient } from "@/backend/google/drive";
import type { SavePdfOptions, StoredPdfRecord } from "./types";

/**
 * Save raw PDF bytes to Cloudflare R2 storage bucket.
 */
export async function savePdfToR2(
  env: Env,
  params: {
    pdfBytes: Uint8Array;
    filename: string;
    title: string;
  }
): Promise<{ r2Key: string; r2ShareUrl: string } | null> {
  if (!env.R2_FILES_BUCKET) {
    return null;
  }

  const date = new Date();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const randomSuffix = crypto.randomUUID().slice(0, 10);
  const cleanFilename = params.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `pdfs/${year}/${month}/${randomSuffix}_${cleanFilename}`;

  await env.R2_FILES_BUCKET.put(r2Key, params.pdfBytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `inline; filename="${cleanFilename}"`,
    },
    customMetadata: {
      title: params.title,
      generatedAt: date.toISOString(),
    },
  });

  const baseUrl = env.PUBLIC_BASE_URL || "";
  const r2ShareUrl = `${baseUrl}/api/pdf/r2/${encodeURIComponent(r2Key)}`;

  return { r2Key, r2ShareUrl };
}

/**
 * Save PDF to Google Drive in a specified folder, or creates the folder by name.
 * Optionally applies sharing permissions ("anyone-viewer", etc.).
 */
export async function savePdfToDrive(
  env: Env,
  params: {
    pdfBytes: Uint8Array;
    filename: string;
    accountRef?: string;
    folderId?: string;
    folderName?: string;
    parentFolderId?: string;
    sharingRole?: string; // "anyone-viewer" | "restricted" | "anyone-commenter" | "anyone-editor"
  }
): Promise<{
  driveFileId: string;
  driveUrl: string;
  driveFolderId?: string;
  driveFolderName?: string;
  driveAccountEmail?: string;
  driveSharingRole?: string;
}> {
  const accountRef = params.accountRef || "workspace";
  const drive = new GoogleDriveClient(env, accountRef);

  let targetFolderId = params.folderId;
  let targetFolderName = params.folderName;

  // If a folder name is provided but no folderId, find or create the folder
  if (!targetFolderId && params.folderName?.trim()) {
    const parentQuery = params.parentFolderId ? `'${params.parentFolderId}' in parents and ` : "";
    const escapedName = params.folderName.trim().replace(/'/g, "\\'");
    const existingFolders = await drive.listFiles(
      `${parentQuery}mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}'`
    );

    if (existingFolders.length > 0) {
      targetFolderId = existingFolders[0].id;
      targetFolderName = existingFolders[0].name;
    } else {
      const created = await drive.createFolder(params.folderName.trim(), params.parentFolderId);
      targetFolderId = created.id;
      targetFolderName = created.name;
    }
  }

  // Upload PDF bytes to Google Drive
  const uploaded = await drive.uploadBinaryFile(
    params.filename,
    "application/pdf",
    params.pdfBytes,
    targetFolderId
  );

  const driveFileId = uploaded.id;
  let driveUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`;

  // Apply sharing permissions if requested
  const sharingRole = params.sharingRole || "restricted";
  if (sharingRole.startsWith("anyone-")) {
    const role =
      sharingRole === "anyone-editor"
        ? "writer"
        : sharingRole === "anyone-commenter"
        ? "commenter"
        : "reader";

    try {
      await drive.createPermission(driveFileId, {
        role,
        type: "anyone",
      });
      // Refresh URL
      driveUrl = `https://drive.google.com/file/d/${driveFileId}/view?usp=sharing`;
    } catch (err) {
      console.warn("Could not set anyone-sharing permission on Drive file:", err);
    }
  }

  return {
    driveFileId,
    driveUrl,
    driveFolderId: targetFolderId,
    driveFolderName: targetFolderName,
    driveAccountEmail: accountRef,
    driveSharingRole: sharingRole,
  };
}

/**
 * Export an existing Google Drive document (Doc/Sheet/Slide) as PDF
 * and saves the generated PDF directly into the SAME folder as the original file.
 */
export async function exportDriveFileToPdfInSameFolder(
  env: Env,
  params: {
    sourceFileId: string;
    accountRef?: string;
    sharingRole?: string;
    newFileName?: string;
    saveToR2Also?: boolean;
  }
): Promise<StoredPdfRecord> {
  const accountRef = params.accountRef || "workspace";
  const drive = new GoogleDriveClient(env, accountRef);

  // 1. Fetch metadata to determine parent folder & mime type
  const meta = await drive.getFileMetadata(params.sourceFileId);
  const parentFolderId = meta.parents && meta.parents.length > 0 ? meta.parents[0] : undefined;

  // 2. Export to PDF (or download if already PDF)
  let pdfBytes: Uint8Array;
  if (meta.mimeType === "application/pdf") {
    const buf = await drive.downloadFile(meta.id);
    pdfBytes = new Uint8Array(buf);
  } else {
    const buf = await drive.exportFile(meta.id, "application/pdf");
    pdfBytes = new Uint8Array(buf);
  }

  // 3. Name the new PDF
  const baseName = meta.name.replace(/\.[^/.]+$/, "");
  const targetPdfName = params.newFileName || `${baseName}.pdf`;

  // 4. Save the generated PDF in the same folder on Drive
  const driveRes = await savePdfToDrive(env, {
    pdfBytes,
    filename: targetPdfName,
    accountRef,
    folderId: parentFolderId,
    sharingRole: params.sharingRole,
  });

  // 5. Optionally save to R2
  let r2Info: { r2Key: string; r2ShareUrl: string } | null = null;
  if (params.saveToR2Also && env.R2_FILES_BUCKET) {
    r2Info = await savePdfToR2(env, {
      pdfBytes,
      filename: targetPdfName,
      title: targetPdfName,
    });
  }

  // 6. Record in D1
  const db = drizzle(env.DB, { schema });
  const id = `pdf_${crypto.randomUUID().slice(0, 12)}`;
  const workerViewToken = crypto.randomUUID();
  const now = new Date();

  await db
    .insert(pdfGenerationLogs)
    .values({
      id,
      title: targetPdfName,
      inputDataJson: JSON.stringify({ sourceFileId: params.sourceFileId, sourceFileName: meta.name }),
      byteSize: pdfBytes.byteLength,
      pageCount: 1,
      r2Key: r2Info?.r2Key ?? null,
      r2ShareUrl: r2Info?.r2ShareUrl ?? null,
      driveFileId: driveRes.driveFileId,
      driveUrl: driveRes.driveUrl,
      driveFolderId: driveRes.driveFolderId ?? null,
      driveFolderName: driveRes.driveFolderName ?? null,
      driveAccountEmail: driveRes.driveAccountEmail ?? null,
      driveSharingRole: driveRes.driveSharingRole ?? null,
      workerViewToken,
      workerViewMode: "direct-worker",
      allowDownload: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const baseUrl = env.PUBLIC_BASE_URL || "";
  return {
    id,
    title: targetPdfName,
    byteSize: pdfBytes.byteLength,
    pageCount: 1,
    r2Key: r2Info?.r2Key ?? null,
    r2ShareUrl: r2Info?.r2ShareUrl ?? null,
    driveFileId: driveRes.driveFileId,
    driveUrl: driveRes.driveUrl,
    driveFolderId: driveRes.driveFolderId ?? null,
    driveFolderName: driveRes.driveFolderName ?? null,
    driveAccountEmail: driveRes.driveAccountEmail ?? null,
    driveSharingRole: driveRes.driveSharingRole ?? null,
    workerViewToken,
    workerViewMode: "direct-worker",
    workerViewUrl: `${baseUrl}/gws/pdf-view/${workerViewToken}`,
    allowDownload: true,
    createdAt: now,
  };
}

/**
 * Coordinate full save workflow: R2 + Drive + D1 generation log recording.
 */
export async function savePdfFullWorkflow(
  env: Env,
  options: SavePdfOptions
): Promise<StoredPdfRecord> {
  const filename = options.filename || `${options.title.toLowerCase().replace(/[^a-z0-9]/g, "_")}.pdf`;
  const pdfId = `pdf_${crypto.randomUUID().slice(0, 12)}`;
  const workerViewToken = crypto.randomUUID();
  const now = new Date();

  let r2Key: string | null = null;
  let r2ShareUrl: string | null = null;
  let driveFileId: string | null = null;
  let driveUrl: string | null = null;
  let driveFolderId: string | null = null;
  let driveFolderName: string | null = null;
  let driveAccountEmail: string | null = null;
  let driveSharingRole: string | null = options.driveSharingRole || null;

  // 1. R2 Storage (default true if bucket bound)
  if (options.saveToR2 !== false && env.R2_FILES_BUCKET) {
    try {
      const r2Res = await savePdfToR2(env, {
        pdfBytes: options.pdfBytes,
        filename,
        title: options.title,
      });
      if (r2Res) {
        r2Key = r2Res.r2Key;
        r2ShareUrl = r2Res.r2ShareUrl;
      }
    } catch (err) {
      console.warn("Failed saving PDF to R2:", err);
    }
  }

  // 2. Google Drive Storage
  if (options.saveToDrive) {
    try {
      const driveRes = await savePdfToDrive(env, {
        pdfBytes: options.pdfBytes,
        filename,
        accountRef: options.driveAccountRef,
        folderId: options.driveFolderId,
        folderName: options.driveFolderName,
        parentFolderId: options.driveParentFolderId,
        sharingRole: options.driveSharingRole,
      });
      driveFileId = driveRes.driveFileId;
      driveUrl = driveRes.driveUrl;
      driveFolderId = driveRes.driveFolderId || null;
      driveFolderName = driveRes.driveFolderName || null;
      driveAccountEmail = driveRes.driveAccountEmail || null;
      driveSharingRole = driveRes.driveSharingRole || null;
    } catch (err) {
      console.warn("Failed saving PDF to Google Drive:", err);
    }
  }

  // 3. Persist log in D1
  const db = drizzle(env.DB, { schema });
  const viewMode = options.workerViewMode || "direct-worker";
  const allowDownload = options.allowDownload !== false;

  await db
    .insert(pdfGenerationLogs)
    .values({
      id: pdfId,
      templateId: options.templateId ?? null,
      title: options.title,
      inputDataJson: options.inputData ? JSON.stringify(options.inputData) : "[]",
      schemaSnapshotJson: options.schemaSnapshot ? JSON.stringify(options.schemaSnapshot) : null,
      byteSize: options.pdfBytes.byteLength,
      pageCount: options.schemaSnapshot?.schemas?.length ?? 1,
      r2Key,
      r2ShareUrl,
      driveFileId,
      driveUrl,
      driveFolderId,
      driveFolderName,
      driveAccountEmail,
      driveSharingRole,
      workerViewToken,
      workerViewMode: viewMode,
      allowDownload,
      status: "ready",
      createdBy: options.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const baseUrl = env.PUBLIC_BASE_URL || "";
  return {
    id: pdfId,
    title: options.title,
    templateId: options.templateId,
    byteSize: options.pdfBytes.byteLength,
    pageCount: options.schemaSnapshot?.schemas?.length ?? 1,
    r2Key,
    r2ShareUrl,
    driveFileId,
    driveUrl,
    driveFolderId,
    driveFolderName,
    driveAccountEmail,
    driveSharingRole,
    workerViewToken,
    workerViewMode: viewMode,
    workerViewUrl: `${baseUrl}/gws/pdf-view/${workerViewToken}`,
    allowDownload,
    createdAt: now,
  };
}

/**
 * Update sharing role on a Google Drive file or folder.
 */
export async function updateDriveSharing(
  env: Env,
  params: {
    fileId: string;
    accountRef?: string;
    role: "reader" | "commenter" | "writer";
    type: "anyone" | "user" | "domain";
    emailAddress?: string;
  }
) {
  const drive = new GoogleDriveClient(env, params.accountRef || "workspace");
  return drive.createPermission(params.fileId, {
    role: params.role,
    type: params.type,
    emailAddress: params.emailAddress,
  });
}
