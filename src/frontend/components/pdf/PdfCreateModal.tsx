/**
 * @file src/frontend/components/pdf/PdfCreateModal.tsx
 * @description Dialog modal for customizing template variables, selecting
 * R2 and Google Drive storage options, and rendering a PDF via pdfme.
 */
import React, { useState, useEffect } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Sparkles,
  HardDrive,
  Cloud,
  Check,
  ExternalLink,
  Download,
  AlertCircle,
  Copy,
  Lock,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfTemplateItem } from "./PdfTemplateBrowserDialog";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";

interface PdfCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: PdfTemplateItem | null;
  onSuccess?: (record: PdfGenerationLog) => void;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function PdfCreateModal({
  open,
  onOpenChange,
  template,
  onSuccess,
}: PdfCreateModalProps) {
  if (!template) return null;

  const [title, setTitle] = useState(template.name);
  const [filename, setFilename] = useState(`${template.id}-${Date.now()}.pdf`);
  const [inputVariables, setInputVariables] = useState<Record<string, any>>({});
  const [inputsJsonStr, setInputsJsonStr] = useState<string>("");

  // Storage targets
  const [saveToR2, setSaveToR2] = useState(true);
  const [saveToDrive, setSaveToDrive] = useState(false);
  const [driveFolderName, setDriveFolderName] = useState("Generated Documents");
  const [driveSharingRole, setDriveSharingRole] = useState<
    "restricted" | "anyone-viewer" | "anyone-commenter" | "anyone-editor"
  >("anyone-viewer");
  const [workerViewMode, setWorkerViewMode] = useState<"direct-worker" | "drive-embed">(
    "direct-worker"
  );
  const [allowDownload, setAllowDownload] = useState(true);

  // Execution state
  const [isRendering, setIsRendering] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [generatedResult, setGeneratedResult] = useState<{
    record: PdfGenerationLog;
    pdfBase64?: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Initialize inputs from template sample data
  useEffect(() => {
    setTitle(template.name);
    setFilename(`${template.id}-${Date.now()}.pdf`);
    setGeneratedResult(null);
    setErrorMsg(null);

    let sample: Record<string, any> = {};
    if (template.sampleDataJson) {
      try {
        const parsed = JSON.parse(template.sampleDataJson);
        sample = Array.isArray(parsed) ? parsed[0] || {} : parsed;
      } catch {}
    }
    setInputVariables(sample);
    setInputsJsonStr(JSON.stringify([sample], null, 2));
  }, [template, open]);

  const handleInputChange = (key: string, val: string) => {
    const updated = { ...inputVariables, [key]: val };
    setInputVariables(updated);
    setInputsJsonStr(JSON.stringify([updated], null, 2));
  };

  const handleRender = async () => {
    setIsRendering(true);
    setErrorMsg(null);
    setGeneratedResult(null);

    let finalInputs = [inputVariables];
    try {
      if (inputsJsonStr.trim()) {
        const parsed = JSON.parse(inputsJsonStr);
        finalInputs = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (e: any) {
      setErrorMsg(`JSON format error in variables: ${e.message}`);
      setIsRendering(false);
      return;
    }

    try {
      const resp = await fetchJson<{
        success: boolean;
        record: PdfGenerationLog;
        pdfBase64?: string;
      }>(
        "/api/pdf/render",
        {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            templateId: template.id,
            title: title.trim() || template.name,
            filename: filename.trim() || undefined,
            inputs: finalInputs,
            saveRecord: true,
            saveToR2,
            saveToDrive,
            driveFolderName: saveToDrive ? driveFolderName.trim() : undefined,
            driveSharingRole: saveToDrive ? driveSharingRole : undefined,
            workerViewMode,
            allowDownload,
          }),
        },
        { source: "pdf-render:create", friendly: "Failed to render PDF document" }
      );

      if (resp.record) {
        setGeneratedResult({ record: resp.record, pdfBase64: resp.pdfBase64 });
        if (onSuccess) {
          onSuccess(resp.record);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed rendering PDF");
    } finally {
      setIsRendering(false);
    }
  };

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Inspect schema fields
  const schemaFields = React.useMemo(() => {
    try {
      const parsed = JSON.parse(template.schemaJson);
      const firstPage = Array.isArray(parsed?.schemas) ? parsed.schemas[0] || {} : {};
      return Object.keys(firstPage);
    } catch {
      return Object.keys(inputVariables);
    }
  }, [template.schemaJson, inputVariables]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-neutral-950 border-neutral-800 text-neutral-100 p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-neutral-800/80 bg-neutral-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Sparkles className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-neutral-100">
                Render Document: {template.name}
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-400 mt-0.5">
                Customize data inputs and select Google Drive or R2 delivery destinations.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {generatedResult ? (
            /* Success State */
            <div className="space-y-4 py-2">
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-start gap-3">
                <Check className="size-5 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold">PDF Rendered & Stored Successfully!</h4>
                  <p className="text-xs text-emerald-300/80 mt-1">
                    Your document is ready with locked-down sharing tokens and storage synchronization.
                  </p>
                </div>
              </div>

              {/* Quick links */}
              <div className="space-y-2 pt-2">
                <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Lock className="size-4 text-sky-400" />
                    <div>
                      <span className="text-xs font-medium text-neutral-200 block">
                        Locked-Down Recipient Viewer
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        {`/gws/pdf-view/${generatedResult.record.workerViewToken}`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleCopy(
                          `${window.location.origin}/gws/pdf-view/${generatedResult.record.workerViewToken}`,
                          "viewToken"
                        )
                      }
                      className="h-8 border-neutral-800 bg-neutral-950 text-neutral-300 text-xs"
                    >
                      {copiedKey === "viewToken" ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                    </Button>
                    <a
                      href={`/gws/pdf-view/${generatedResult.record.workerViewToken}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-8 inline-flex items-center justify-center bg-sky-600 hover:bg-sky-500 text-white text-xs px-2.5 rounded-md transition-colors"
                    >
                      <ExternalLink className="size-3 mr-1" />
                      Open
                    </a>
                  </div>
                </div>

                {generatedResult.record.driveUrl && (
                  <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <HardDrive className="size-4 text-emerald-400" />
                      <div>
                        <span className="text-xs font-medium text-neutral-200 block">
                          Google Drive Document
                        </span>
                        <span className="text-[11px] text-neutral-400">
                          {generatedResult.record.driveFolderName || "My Drive"}
                        </span>
                      </div>
                    </div>
                    <a
                      href={generatedResult.record.driveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-8 inline-flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-2.5 rounded-md transition-colors"
                    >
                      <ExternalLink className="size-3 mr-1" />
                      Drive
                    </a>
                  </div>
                )}

                <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-900/60 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Download className="size-4 text-amber-400" />
                    <div>
                      <span className="text-xs font-medium text-neutral-200 block">
                        Download Raw PDF
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        {generatedResult.record.byteSize ? `${(generatedResult.record.byteSize / 1024).toFixed(1)} KB` : "0 KB"}
                      </span>
                    </div>
                  </div>
                  <a
                    href={`/api/pdf/raw/${generatedResult.record.workerViewToken}?download=1`}
                    download
                    className="h-8 inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 text-neutral-200 text-xs px-2.5 rounded-md transition-colors"
                  >
                    <Download className="size-3 mr-1" />
                    Download
                  </a>
                </div>
              </div>
            </div>
          ) : (
            /* Creation Form */
            <div className="space-y-5">
              {/* Document Identity */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-neutral-400">Document Title</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                  />
                </div>
                <div>
                  <Label className="text-xs text-neutral-400">PDF Filename</Label>
                  <Input
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                  />
                </div>
              </div>

              {/* Template Variables Form */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-neutral-300 uppercase tracking-wider">
                    Template Variables & Data Fields
                  </Label>
                  <Badge variant="outline" className="text-[10px] border-neutral-800 text-neutral-400">
                    {schemaFields.length} Fields Detected
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2.5 max-h-48 overflow-y-auto p-1 rounded-lg border border-neutral-800/80 bg-neutral-900/30">
                  {schemaFields.map((field) => {
                    const val = inputVariables[field];
                    const isComplex = typeof val === "object" && val !== null;
                    return (
                      <div key={field} className={isComplex ? "col-span-2" : "col-span-1"}>
                        <Label className="text-[11px] text-neutral-400 font-mono truncate block">
                          {field}
                        </Label>
                        <Input
                          value={isComplex ? JSON.stringify(val) : val ?? ""}
                          onChange={(e) => handleInputChange(field, e.target.value)}
                          placeholder={`Enter ${field}...`}
                          className="h-8 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Storage Targets */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-4">
                <h4 className="text-xs font-medium text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Cloud className="size-4 text-sky-400" />
                  Storage & Delivery Destinations
                </h4>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-xs font-medium text-neutral-300">
                      Cloudflare R2 Bucket
                    </Label>
                    <p className="text-[11px] text-neutral-400">
                      Store binary PDF in R2 with persistent public key.
                    </p>
                  </div>
                  <Switch checked={saveToR2} onCheckedChange={setSaveToR2} />
                </div>

                <div className="pt-2 border-t border-neutral-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-xs font-medium text-neutral-300 flex items-center gap-1.5">
                        <HardDrive className="size-3.5 text-emerald-400" />
                        Google Drive Sync & Folder Creation
                      </Label>
                      <p className="text-[11px] text-neutral-400">
                        Upload to Google Drive with automated folder creation and sharing permissions.
                      </p>
                    </div>
                    <Switch checked={saveToDrive} onCheckedChange={setSaveToDrive} />
                  </div>

                  {saveToDrive && (
                    <div className="grid grid-cols-2 gap-3 pt-2">
                      <div>
                        <Label className="text-xs text-neutral-400">Destination Folder Name</Label>
                        <Input
                          value={driveFolderName}
                          onChange={(e) => setDriveFolderName(e.target.value)}
                          placeholder="e.g. Invoices"
                          className="h-8 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-neutral-400">Drive Sharing Role</Label>
                        <Select
                          value={driveSharingRole}
                          onValueChange={(val: any) => setDriveSharingRole(val)}
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
                    </div>
                  )}
                </div>

                {/* Worker View Configuration */}
                <div className="pt-2 border-t border-neutral-800/80 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-xs font-medium text-neutral-300">Allow Direct Download</Label>
                    <p className="text-[11px] text-neutral-400">
                      Recipients of the worker view link can download the raw PDF.
                    </p>
                  </div>
                  <Switch checked={allowDownload} onCheckedChange={setAllowDownload} />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-4 border-t border-neutral-800 bg-neutral-900/40 flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-neutral-400 hover:text-neutral-200 text-xs"
          >
            {generatedResult ? "Close" : "Cancel"}
          </Button>

          {!generatedResult && (
            <Button
              onClick={handleRender}
              disabled={isRendering || !title.trim()}
              className="bg-sky-600 hover:bg-sky-500 text-white text-xs h-9"
            >
              {isRendering ? (
                <span className="flex items-center gap-2">
                  <Sparkles className="size-3.5 animate-spin" />
                  Rendering PDF...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <FileText className="size-3.5" />
                  Render & Store PDF
                </span>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
