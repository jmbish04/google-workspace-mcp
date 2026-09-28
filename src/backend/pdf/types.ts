/**
 * @file src/backend/pdf/types.ts
 * @description Type definitions for the PDF generation, template, storage,
 * sharing, and delivery subsystems.
 */

export interface PdfmePosition {
  x: number;
  y: number;
}

export interface PdfmeBasePdfCustom {
  width: number;
  height: number;
  padding: [number, number, number, number];
}

export type PdfmeBasePdf = string | PdfmeBasePdfCustom;

export interface PdfmeTemplateDefinition {
  basePdf: PdfmeBasePdf;
  schemas: Record<string, any>[][];
  pdfmeVersion?: string;
}

export interface RenderPdfOptions {
  template: PdfmeTemplateDefinition;
  inputs: Record<string, any>[];
}

export interface RenderPdfResult {
  pdfBytes: Uint8Array;
  byteSize: number;
  pageCount: number;
}

export type DriveSharingRole = "restricted" | "anyone-viewer" | "anyone-commenter" | "anyone-editor";
export type WorkerViewMode = "direct-worker" | "drive-embed";

export interface SavePdfOptions {
  title: string;
  filename?: string;
  pdfBytes: Uint8Array;
  templateId?: string;
  inputData?: Record<string, any>[];
  schemaSnapshot?: PdfmeTemplateDefinition;
  
  // Storage destinations
  saveToR2?: boolean;
  saveToDrive?: boolean;
  
  // Drive options
  driveAccountRef?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  driveParentFolderId?: string;
  driveSharingRole?: DriveSharingRole;
  
  // Worker view options
  workerViewMode?: WorkerViewMode;
  allowDownload?: boolean;
  createdBy?: string;
}

export interface StoredPdfRecord {
  id: string;
  title: string;
  templateId?: string | null;
  byteSize: number;
  pageCount: number;
  r2Key?: string | null;
  r2ShareUrl?: string | null;
  driveFileId?: string | null;
  driveUrl?: string | null;
  driveFolderId?: string | null;
  driveFolderName?: string | null;
  driveAccountEmail?: string | null;
  driveSharingRole?: string | null;
  workerViewToken: string;
  workerViewMode: WorkerViewMode;
  workerViewUrl: string;
  allowDownload: boolean;
  createdAt: Date;
}
