/**
 * @file src/frontend/components/pdf/PdfDriveConvertModal.tsx
 * @description Dialog modal for converting any Google Doc or Google Sheet to PDF
 * via the Google Drive API and saving the resulting PDF into the exact same folder.
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  HardDrive,
  Sparkles,
  Check,
  ExternalLink,
  AlertCircle,
  FolderSync,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";

interface PdfDriveConvertModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (record: PdfGenerationLog) => void;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function PdfDriveConvertModal({
  open,
  onOpenChange,
  onSuccess,
}: PdfDriveConvertModalProps) {
  const [sourceRef, setSourceRef] = useState("");
  const [customName, setCustomName] = useState("");
  const [sharingRole, setSharingRole] = useState<
    "anyone-viewer" | "restricted" | "anyone-editor"
  >("anyone-viewer");
  const [saveToR2, setSaveToR2] = useState(true);

  const [isConverting, setIsConverting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultRecord, setResultRecord] = useState<PdfGenerationLog | null>(null);

  const handleConvert = async () => {
    if (!sourceRef.trim()) return;
    setIsConverting(true);
    setErrorMsg(null);
    setResultRecord(null);

    try {
      const resp = await fetchJson<{
        success: boolean;
        record: PdfGenerationLog;
      }>(
        "/api/pdf/drive-convert",
        {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            sourceFileId: sourceRef.trim(),
            newFileName: customName.trim() || undefined,
            sharingRole,
            saveToR2Also: saveToR2,
          }),
        },
        { source: "pdf-drive:convert", friendly: "Failed to convert Google Drive document to PDF" }
      );

      if (resp.record) {
        setResultRecord(resp.record);
        if (onSuccess) {
          onSuccess(resp.record);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed converting Drive document to PDF");
    } finally {
      setIsConverting(false);
    }
  };

  const handleReset = () => {
    setSourceRef("");
    setCustomName("");
    setResultRecord(null);
    setErrorMsg(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-neutral-950 border-neutral-800 text-neutral-100 p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-neutral-800/80 bg-neutral-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <FolderSync className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-neutral-100">
                Convert Drive Doc / Sheet to PDF
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-400 mt-0.5">
                Exports Google Doc or Sheet to PDF and places it in the exact same parent folder.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 space-y-5">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {resultRecord ? (
            <div className="space-y-4 py-2">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-start gap-3">
                <Check className="size-5 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold">Drive File Converted to PDF!</h4>
                  <p className="text-xs text-emerald-300/80 mt-1">
                    The PDF has been created and saved directly inside folder:{" "}
                    <strong>{resultRecord.driveFolderName || "Original Folder"}</strong>.
                  </p>
                </div>
              </div>

              <div className="space-y-2 pt-2">
                {resultRecord.driveUrl && (
                  <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive className="size-4 text-emerald-400" />
                      <div>
                        <span className="text-xs font-medium text-neutral-200 block">
                          {resultRecord.title}
                        </span>
                        <span className="text-[11px] text-neutral-400">
                          {resultRecord.driveSharingRole || "Google Drive"}
                        </span>
                      </div>
                    </div>
                    <a
                      href={resultRecord.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-8 inline-flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-2.5 rounded-md transition-colors"
                    >
                      <ExternalLink className="size-3 mr-1" />
                      Open on Drive
                    </a>
                  </div>
                )}

                <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="size-4 text-sky-400" />
                    <div>
                      <span className="text-xs font-medium text-neutral-200 block">
                        Locked-Down Recipient Viewer
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        {`/gws/pdf-view/${resultRecord.workerViewToken}`}
                      </span>
                    </div>
                  </div>
                  <a
                    href={`/gws/pdf-view/${resultRecord.workerViewToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 text-neutral-200 text-xs px-2.5 rounded-md transition-colors"
                  >
                    <ExternalLink className="size-3 mr-1" />
                    View
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-neutral-300">
                  Google Doc / Sheet File ID or Full URL
                </Label>
                <Input
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  placeholder="https://docs.google.com/document/d/1a2b3c... or raw ID"
                  className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200 font-mono"
                />
                <p className="text-[11px] text-neutral-500 mt-1">
                  Supports full Google Docs, Sheets, or Drive URLs automatically.
                </p>
              </div>

              <div>
                <Label className="text-xs text-neutral-300">
                  Custom Output PDF Name (Optional)
                </Label>
                <Input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="e.g. Q3-Financial-Report.pdf"
                  className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <Label className="text-xs text-neutral-300">New PDF Sharing Role</Label>
                  <Select
                    value={sharingRole}
                    onValueChange={(val: any) => { if (val) setSharingRole(val); }}
                  >
                    <SelectTrigger className="h-8 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-neutral-900 border-neutral-800 text-neutral-200">
                      <SelectItem value="anyone-viewer">Anyone with link (Viewer)</SelectItem>
                      <SelectItem value="restricted">Restricted (Owner only)</SelectItem>
                      <SelectItem value="anyone-editor">Anyone with link (Editor)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col justify-end">
                  <div className="flex items-center justify-between p-2 rounded-lg border border-neutral-800 bg-neutral-900/40">
                    <Label className="text-xs text-neutral-300">Save to R2 Also</Label>
                    <Switch checked={saveToR2} onCheckedChange={setSaveToR2} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-4 border-t border-neutral-800 bg-neutral-900/40 flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={handleReset}
            className="text-neutral-400 hover:text-neutral-200 text-xs"
          >
            {resultRecord ? "Done" : "Cancel"}
          </Button>

          {!resultRecord && (
            <Button
              onClick={handleConvert}
              disabled={isConverting || !sourceRef.trim()}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-9"
            >
              {isConverting ? (
                <span className="flex items-center gap-2">
                  <Sparkles className="size-3.5 animate-spin" />
                  Exporting to PDF...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <FolderSync className="size-3.5" />
                  Export to Same Folder
                </span>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
