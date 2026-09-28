/**
 * @file src/frontend/components/pdf/PdfDetailsSheet.tsx
 * @description Slide-over sheet for inspecting PDF metadata, storage paths,
 * generation inputs, and triggering quick actions (view, download, email, sharing, template conversion).
 */
import React, { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  FileText,
  ExternalLink,
  Download,
  Share2,
  Mail,
  Wand2,
  HardDrive,
  Cloud,
  Lock,
  Calendar,
  Layers,
  Check,
  Copy,
  ChevronRight,
  Folder,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";

interface PdfDetailsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: PdfGenerationLog | null;
  onOpenSharing: (record: PdfGenerationLog) => void;
  onOpenEmail: (record: PdfGenerationLog) => void;
  onConvertedToTemplate?: (templateName: string) => void;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function PdfDetailsSheet({
  open,
  onOpenChange,
  record,
  onOpenSharing,
  onOpenEmail,
  onConvertedToTemplate,
}: PdfDetailsSheetProps) {
  if (!record) return null;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [convertName, setConvertName] = useState(record.title || "Custom Template");
  const [showConvertForm, setShowConvertForm] = useState(false);
  const [convertSuccess, setConvertSuccess] = useState<string | null>(null);

  const lockedDownUrl = typeof window !== "undefined"
    ? `${window.location.origin}/gws/pdf-view/${record.workerViewToken}`
    : `/gws/pdf-view/${record.workerViewToken}`;

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleConvertToTemplate = async () => {
    setIsConverting(true);
    setConvertSuccess(null);
    try {
      await fetchJson(
        `/api/pdf/logs/${record.id}/convert-to-template`,
        {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            name: convertName.trim() || record.title,
            category: "custom",
            description: `Generated from historical PDF run "${record.title}"`,
          }),
        },
        { source: "pdf-logs:convert", friendly: "Failed to convert log to template" }
      );
      setConvertSuccess(`Successfully saved "${convertName}" as a reusable template!`);
      setShowConvertForm(false);
      if (onConvertedToTemplate) {
        onConvertedToTemplate(convertName);
      }
    } catch {
      // logged by fetchJson
    } finally {
      setIsConverting(false);
    }
  };

  let parsedInputs: any = [];
  try {
    parsedInputs = JSON.parse(record.inputDataJson || "[]");
  } catch {}

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md md:max-w-lg bg-neutral-950 border-neutral-800 text-neutral-100 p-0 flex flex-col h-full">
        {/* Header */}
        <SheetHeader className="p-6 pb-4 border-b border-neutral-800/80 bg-neutral-900/40 shrink-0">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 shrink-0 mt-0.5">
              <FileText className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <SheetTitle className="text-base font-semibold text-neutral-100 truncate">
                  {record.title}
                </SheetTitle>
                <Badge
                  variant="outline"
                  className={
                    record.status === "ready"
                      ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10 text-[10px]"
                      : "border-amber-500/30 text-amber-400 bg-amber-500/10 text-[10px]"
                  }
                >
                  {record.status}
                </Badge>
              </div>
              <SheetDescription className="text-xs text-neutral-400 mt-1 flex items-center gap-3">
                <span>{record.pageCount} {record.pageCount === 1 ? "page" : "pages"}</span>
                <span>•</span>
                <span>{formatBytes(record.byteSize)}</span>
                <span>•</span>
                <span>
                  {record.createdAt ? new Date(record.createdAt).toLocaleDateString() : "Recent"}
                </span>
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        {/* Scrollable Content */}
        <ScrollArea className="flex-1 p-6 space-y-6">
          {/* Quick Actions Bar */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
              Actions
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <a
                href={lockedDownUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="h-9 inline-flex items-center justify-start gap-2 border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs px-3 rounded-md transition-colors"
              >
                <ExternalLink className="size-3.5 text-sky-400" />
                Open Viewer
              </a>

              <a
                href={`/api/pdf/raw/${record.workerViewToken}?download=1`}
                download
                className="h-9 inline-flex items-center justify-start gap-2 border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs px-3 rounded-md transition-colors"
              >
                <Download className="size-3.5 text-emerald-400" />
                Download PDF
              </a>

              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenSharing(record)}
                className="h-9 justify-start gap-2 border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs"
              >
                <Share2 className="size-3.5 text-amber-400" />
                Sharing & Roles
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenEmail(record)}
                className="h-9 justify-start gap-2 border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs"
              >
                <Mail className="size-3.5 text-rose-400" />
                Send via Email
              </Button>
            </div>
          </div>

          <Separator className="bg-neutral-800/80 my-4" />

          {/* Storage Locations */}
          <div className="space-y-3">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
              Storage & Distribution
            </h4>

            {/* Google Drive Status */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                  <HardDrive className="size-4" />
                  Google Drive
                </span>
                <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-300">
                  {record.driveFileId ? (record.driveSharingRole || "Synced") : "Not Uploaded"}
                </Badge>
              </div>

              {record.driveFileId ? (
                <div className="space-y-1.5 text-xs text-neutral-400 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-500">File ID:</span>
                    <span className="font-mono text-neutral-300 text-[11px] truncate max-w-[200px]">
                      {record.driveFileId}
                    </span>
                  </div>
                  {record.driveFolderName && (
                    <div className="flex items-center justify-between">
                      <span className="text-neutral-500">Folder:</span>
                      <span className="flex items-center gap-1 text-neutral-300 text-[11px]">
                        <Folder className="size-3 text-emerald-400" />
                        {record.driveFolderName}
                      </span>
                    </div>
                  )}
                  {record.driveUrl && (
                    <div className="pt-1.5 flex items-center gap-2">
                      <a
                        href={record.driveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-7 text-[11px] flex-1 inline-flex items-center justify-center border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 text-neutral-200 rounded-md transition-colors"
                      >
                        <ExternalLink className="size-3 mr-1 text-emerald-400" />
                        View on Drive
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCopy(record.driveUrl!, "driveUrl")}
                        className="h-7 text-[11px] border-neutral-800 bg-neutral-950 text-neutral-300"
                      >
                        {copiedKey === "driveUrl" ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-neutral-500">Document was generated without Drive sync.</p>
              )}
            </div>

            {/* Cloudflare R2 Status */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-medium text-violet-400">
                  <Cloud className="size-4" />
                  Cloudflare R2 Bucket
                </span>
                <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-300">
                  {record.r2Key ? "Stored" : "None"}
                </Badge>
              </div>

              {record.r2Key && (
                <div className="space-y-1.5 text-xs text-neutral-400 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-500">Key:</span>
                    <span className="font-mono text-neutral-300 text-[11px] truncate max-w-[200px]">
                      {record.r2Key}
                    </span>
                  </div>
                  {record.r2ShareUrl && (
                    <div className="pt-1.5 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCopy(record.r2ShareUrl!, "r2Url")}
                        className="h-7 text-[11px] flex-1 border-neutral-800 bg-neutral-950 text-neutral-200"
                      >
                        {copiedKey === "r2Url" ? <Check className="size-3 mr-1 text-emerald-400" /> : <Copy className="size-3 mr-1" />}
                        Copy R2 Direct Link
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Locked-Down Token */}
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-medium text-sky-400">
                  <Lock className="size-4" />
                  Locked-Down View Token
                </span>
                <Badge variant="outline" className="text-[10px] border-sky-500/30 text-sky-300">
                  {record.workerViewMode}
                </Badge>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(lockedDownUrl, "tokenUrl")}
                  className="h-7 text-[11px] flex-1 border-neutral-800 bg-neutral-950 text-neutral-200"
                >
                  {copiedKey === "tokenUrl" ? <Check className="size-3 mr-1 text-emerald-400" /> : <Copy className="size-3 mr-1" />}
                  Copy Worker Recipient Link
                </Button>
              </div>
            </div>
          </div>

          <Separator className="bg-neutral-800/80 my-4" />

          {/* D1 Log-to-Template Conversion Engine */}
          <div className="rounded-xl border border-sky-500/20 bg-sky-950/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="size-4 text-sky-400" />
                <h4 className="text-xs font-semibold text-neutral-200">
                  Convert to Reusable Template
                </h4>
              </div>
            </div>
            <p className="text-xs text-neutral-400">
              Extract this generated document's layout and field schema snapshot into a repeatable PDF template.
            </p>

            {convertSuccess && (
              <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-2">
                <Check className="size-4 shrink-0" />
                {convertSuccess}
              </div>
            )}

            {!showConvertForm ? (
              <Button
                size="sm"
                onClick={() => setShowConvertForm(true)}
                className="w-full text-xs h-8 bg-sky-600 hover:bg-sky-500 text-white"
              >
                Promote to Template Studio
              </Button>
            ) : (
              <div className="space-y-2 pt-2 border-t border-sky-500/20">
                <input
                  type="text"
                  value={convertName}
                  onChange={(e) => setConvertName(e.target.value)}
                  placeholder="Template Name"
                  className="w-full h-8 px-2.5 rounded-md bg-neutral-950 border border-neutral-800 text-xs text-neutral-100"
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={handleConvertToTemplate}
                    disabled={isConverting}
                    className="flex-1 text-xs h-8 bg-sky-600 hover:bg-sky-500 text-white"
                  >
                    {isConverting ? "Converting..." : "Confirm & Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowConvertForm(false)}
                    className="text-xs h-8 text-neutral-400"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Separator className="bg-neutral-800/80 my-4" />

          {/* Sample Variables Applied */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
              Input Variables
            </h4>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 font-mono text-[11px] text-neutral-300 max-h-48 overflow-y-auto">
              <pre>{JSON.stringify(parsedInputs, null, 2)}</pre>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
