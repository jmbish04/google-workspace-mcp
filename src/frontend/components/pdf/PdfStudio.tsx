/**
 * @file src/frontend/components/pdf/PdfStudio.tsx
 * @description Retrofitted @reui/solution-files-1 Drive Explorer & PDF Studio.
 * Full-height file manager module for browsing generated PDFs and Google Drive files,
 * featuring folder rail filtering, search, switchable grid/list views, metadata inspection,
 * sharing controls, Drive-to-PDF conversion, and email delivery.
 */
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText,
  Search,
  Plus,
  RefreshCw,
  LayoutGrid,
  List as ListIcon,
  HardDrive,
  Cloud,
  Lock,
  ExternalLink,
  MoreVertical,
  Download,
  Share2,
  Mail,
  Wand2,
  Folder,
  Layers,
  Sparkles,
  FolderSync,
  Check,
  Copy,
  Clock,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";
import {
  PdfTemplateBrowserDialog,
  type PdfTemplateItem,
} from "./PdfTemplateBrowserDialog";
import { PdfCreateModal } from "./PdfCreateModal";
import { PdfDetailsSheet } from "./PdfDetailsSheet";
import { PdfSharingDialog } from "./PdfSharingDialog";
import { PdfDriveConvertModal } from "./PdfDriveConvertModal";
import { PdfEmailSendModal } from "./PdfEmailSendModal";

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

type ScopeFilter = "all" | "drive" | "r2" | "view-only" | "public";

export function PdfStudio() {
  const [logs, setLogs] = useState<PdfGenerationLog[]>([]);
  const [templates, setTemplates] = useState<PdfTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeScope, setActiveScope] = useState<ScopeFilter>("all");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "size" | "title">("newest");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Dialog & Modal states
  const [templateBrowserOpen, setTemplateBrowserOpen] = useState(false);
  const [selectedTemplateForCreate, setSelectedTemplateForCreate] = useState<PdfTemplateItem | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);
  const [activeRecord, setActiveRecord] = useState<PdfGenerationLog | null>(null);
  const [sharingDialogOpen, setSharingDialogOpen] = useState(false);
  const [driveConvertModalOpen, setDriveConvertModalOpen] = useState(false);
  const [emailSendModalOpen, setEmailSendModalOpen] = useState(false);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);

  // Load data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [logsData, tmplData] = await Promise.all([
        fetchJson<{ logs: PdfGenerationLog[] }>(
          "/api/pdf/logs?limit=100",
          { headers: authHeaders() },
          { source: "pdf-studio:logs", friendly: "Failed to load PDF generation logs" }
        ),
        fetchJson<{ templates: PdfTemplateItem[] }>(
          "/api/pdf/templates",
          { headers: authHeaders() },
          { source: "pdf-studio:templates", friendly: "Failed to load templates" }
        ),
      ]);
      setLogs(logsData.logs || []);
      setTemplates(tmplData.templates || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Filter & Sort
  const filteredLogs = useMemo(() => {
    return logs
      .filter((log) => {
        // Scope filter
        if (activeScope === "drive" && !log.driveFileId) return false;
        if (activeScope === "r2" && !log.r2Key) return false;
        if (activeScope === "view-only" && log.allowDownload) return false;
        if (activeScope === "public" && (!log.driveSharingRole?.includes("anyone") && !log.r2ShareUrl)) {
          return false;
        }

        // Search query
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          log.title.toLowerCase().includes(q) ||
          (log.driveFolderName && log.driveFolderName.toLowerCase().includes(q)) ||
          (log.templateId && log.templateId.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (sortBy === "newest") {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        if (sortBy === "oldest") {
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        }
        if (sortBy === "size") {
          return (b.byteSize || 0) - (a.byteSize || 0);
        }
        if (sortBy === "title") {
          return a.title.localeCompare(b.title);
        }
        return 0;
      });
  }, [logs, activeScope, searchQuery, sortBy]);

  // Counts for scope rail
  const counts = useMemo(() => {
    return {
      all: logs.length,
      drive: logs.filter((l) => !!l.driveFileId).length,
      r2: logs.filter((l) => !!l.r2Key).length,
      viewOnly: logs.filter((l) => !l.allowDownload).length,
      public: logs.filter((l) => l.driveSharingRole?.includes("anyone") || !!l.r2ShareUrl).length,
    };
  }, [logs]);

  const handleCopyLink = (record: PdfGenerationLog, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = `${window.location.origin}/gws/pdf-view/${record.workerViewToken}`;
    navigator.clipboard.writeText(url);
    setCopiedTokenId(record.id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

  const handleSelectTemplate = (template: PdfTemplateItem) => {
    setTemplateBrowserOpen(false);
    setSelectedTemplateForCreate(template);
    setCreateModalOpen(true);
  };

  const handleOpenDetails = (record: PdfGenerationLog) => {
    setActiveRecord(record);
    setDetailsSheetOpen(true);
  };

  const handleOpenSharing = (record: PdfGenerationLog) => {
    setActiveRecord(record);
    setSharingDialogOpen(true);
  };

  const handleOpenEmail = (record: PdfGenerationLog) => {
    setActiveRecord(record);
    setEmailSendModalOpen(true);
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden bg-neutral-950 text-neutral-100">
      {/* Left Navigation Rail (ReUI Solution Files Pattern) */}
      <aside className="w-64 shrink-0 border-r border-neutral-800/80 bg-neutral-900/30 flex flex-col justify-between p-4">
        <div className="space-y-6">
          {/* Rail Header & Action */}
          <div className="space-y-3">
            <div className="flex items-center gap-2.5 px-2">
              <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <FileText className="size-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-100">
                  PDF & Drive Studio
                </h2>
                <p className="text-[11px] text-neutral-400">pdfme + Google Drive</p>
              </div>
            </div>

            <Button
              onClick={() => setTemplateBrowserOpen(true)}
              className="w-full bg-sky-600 hover:bg-sky-500 text-white text-xs h-9 justify-start gap-2 shadow-sm"
            >
              <Plus className="size-4" />
              New PDF from Template
            </Button>

            <Button
              variant="outline"
              onClick={() => setDriveConvertModalOpen(true)}
              className="w-full border-neutral-800 bg-neutral-900/60 hover:bg-neutral-800 text-neutral-200 text-xs h-8 justify-start gap-2"
            >
              <FolderSync className="size-3.5 text-emerald-400" />
              Convert Drive Doc to PDF
            </Button>
          </div>

          {/* Scope Filters */}
          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider px-2">
              Browse Locations
            </span>

            <button
              onClick={() => setActiveScope("all")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                activeScope === "all"
                  ? "bg-neutral-800 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <Layers className="size-3.5 text-sky-400" />
                All Created PDFs
              </span>
              <span className="text-[11px] font-mono text-neutral-400">{counts.all}</span>
            </button>

            <button
              onClick={() => setActiveScope("drive")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                activeScope === "drive"
                  ? "bg-neutral-800 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <HardDrive className="size-3.5 text-emerald-400" />
                Google Drive Synced
              </span>
              <span className="text-[11px] font-mono text-neutral-400">{counts.drive}</span>
            </button>

            <button
              onClick={() => setActiveScope("r2")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                activeScope === "r2"
                  ? "bg-neutral-800 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <Cloud className="size-3.5 text-violet-400" />
                Cloudflare R2 Bucket
              </span>
              <span className="text-[11px] font-mono text-neutral-400">{counts.r2}</span>
            </button>

            <button
              onClick={() => setActiveScope("public")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                activeScope === "public"
                  ? "bg-neutral-800 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <Share2 className="size-3.5 text-amber-400" />
                Public Share Links
              </span>
              <span className="text-[11px] font-mono text-neutral-400">{counts.public}</span>
            </button>

            <button
              onClick={() => setActiveScope("view-only")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                activeScope === "view-only"
                  ? "bg-neutral-800 text-neutral-100 font-medium"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              }`}
            >
              <span className="flex items-center gap-2">
                <Lock className="size-3.5 text-rose-400" />
                View Only (No Download)
              </span>
              <span className="text-[11px] font-mono text-neutral-400">{counts.viewOnly}</span>
            </button>
          </div>
        </div>

        {/* Rail Footer / System Info */}
        <div className="p-3 rounded-xl border border-neutral-800/80 bg-neutral-900/50 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">Templates</span>
            <span className="font-semibold text-neutral-200">{templates.length} Active</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-400">Total Runs</span>
            <span className="font-semibold text-neutral-200">{logs.length} Docs</span>
          </div>
        </div>
      </aside>

      {/* Main Browse Surface */}
      <main className="flex-1 flex flex-col overflow-hidden bg-neutral-950">
        {/* Top Action Toolbar */}
        <div className="h-14 shrink-0 border-b border-neutral-800/80 px-6 flex items-center justify-between gap-4 bg-neutral-900/20">
          <div className="flex items-center gap-3 flex-1 max-w-md">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-neutral-400" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search PDF titles, folders, or templates..."
                className="h-8 pl-9 bg-neutral-900/60 border-neutral-800 text-xs text-neutral-200"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Select value={sortBy} onValueChange={(val: any) => setSortBy(val)}>
              <SelectTrigger className="h-8 w-32 bg-neutral-900/60 border-neutral-800 text-xs text-neutral-300">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-neutral-900 border-neutral-800 text-neutral-200">
                <SelectItem value="newest">Newest First</SelectItem>
                <SelectItem value="oldest">Oldest First</SelectItem>
                <SelectItem value="size">Largest Size</SelectItem>
                <SelectItem value="title">Title A-Z</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center border border-neutral-800 rounded-lg p-0.5 bg-neutral-900/40">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setViewMode("grid")}
                className={`h-7 px-2 text-xs rounded-md ${
                  viewMode === "grid" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
                }`}
              >
                <LayoutGrid className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setViewMode("list")}
                className={`h-7 px-2 text-xs rounded-md ${
                  viewMode === "list" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400"
                }`}
              >
                <ListIcon className="size-3.5" />
              </Button>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadData()}
              className="h-8 px-2.5 border-neutral-800 bg-neutral-900/60 hover:bg-neutral-800 text-neutral-300"
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Content Explorer Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && logs.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="h-44 rounded-xl border border-neutral-800/60 bg-neutral-900/30 animate-pulse"
                />
              ))}
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="h-96 flex flex-col items-center justify-center text-center p-8 rounded-2xl border border-dashed border-neutral-800/80 bg-neutral-900/10">
              <div className="size-12 rounded-2xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center mb-3">
                <FileText className="size-6" />
              </div>
              <h3 className="text-base font-semibold text-neutral-200">No Documents Found</h3>
              <p className="text-xs text-neutral-400 mt-1 max-w-sm">
                {searchQuery
                  ? `No PDFs match the search term "${searchQuery}".`
                  : "Generate your first PDF document from our preloaded templates or convert a Google Doc."}
              </p>
              <div className="flex items-center gap-2 mt-4">
                <Button
                  size="sm"
                  onClick={() => setTemplateBrowserOpen(true)}
                  className="bg-sky-600 hover:bg-sky-500 text-white text-xs h-8"
                >
                  <Plus className="size-3.5 mr-1.5" />
                  Choose Template
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDriveConvertModalOpen(true)}
                  className="border-neutral-800 bg-neutral-900 text-neutral-300 text-xs h-8"
                >
                  <FolderSync className="size-3.5 mr-1.5 text-emerald-400" />
                  Convert Doc
                </Button>
              </div>
            </div>
          ) : viewMode === "grid" ? (
            /* Grid View */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  onClick={() => handleOpenDetails(log)}
                  className="group relative rounded-xl border border-neutral-800/80 bg-neutral-900/40 hover:bg-neutral-900/80 hover:border-neutral-700 transition-all p-4 cursor-pointer flex flex-col justify-between space-y-4"
                >
                  <div>
                    {/* Top Row: Icon + Storage Badges */}
                    <div className="flex items-start justify-between">
                      <div className="p-2.5 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 group-hover:bg-sky-500/20 transition-colors">
                        <FileText className="size-5" />
                      </div>

                      <div className="flex items-center gap-1.5">
                        {log.driveFileId && (
                          <span
                            title="Synced to Google Drive"
                            className="p-1 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          >
                            <HardDrive className="size-3.5" />
                          </span>
                        )}
                        {log.r2Key && (
                          <span
                            title="Stored in Cloudflare R2"
                            className="p-1 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20"
                          >
                            <Cloud className="size-3.5" />
                          </span>
                        )}
                        {!log.allowDownload && (
                          <span
                            title="View Only (Download prohibited)"
                            className="p-1 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20"
                          >
                            <Lock className="size-3.5" />
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Title & Metadata */}
                    <div className="mt-3">
                      <h4 className="text-sm font-semibold text-neutral-100 line-clamp-1 group-hover:text-sky-300 transition-colors">
                        {log.title}
                      </h4>
                      <p className="text-[11px] text-neutral-400 mt-1 flex items-center gap-2">
                        <span>{formatBytes(log.byteSize)}</span>
                        <span>•</span>
                        <span>{log.pageCount} {log.pageCount === 1 ? "page" : "pages"}</span>
                      </p>
                      {log.driveFolderName && (
                        <div className="flex items-center gap-1 text-[11px] text-emerald-400/80 mt-1 truncate">
                          <Folder className="size-3 shrink-0" />
                          <span className="truncate">{log.driveFolderName}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Card Footer: Date & Quick Actions */}
                  <div className="pt-2 border-t border-neutral-800/80 flex items-center justify-between text-xs">
                    <span className="text-[11px] text-neutral-400 flex items-center gap-1">
                      <Clock className="size-3" />
                      {new Date(log.createdAt).toLocaleDateString()}
                    </span>

                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Copy Recipient Viewer Link"
                        onClick={(e) => handleCopyLink(log, e)}
                        className="size-7 p-0 text-neutral-400 hover:text-neutral-100"
                      >
                        {copiedTokenId === log.id ? (
                          <Check className="size-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger className="size-7 p-0 inline-flex items-center justify-center text-neutral-400 hover:text-neutral-100 rounded-md hover:bg-neutral-800 transition-colors">
                          <MoreVertical className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="bg-neutral-900 border-neutral-800 text-neutral-200 text-xs w-48"
                        >
                          <DropdownMenuItem
                            onClick={() => window.open(`/gws/pdf-view/${log.workerViewToken}`, "_blank")}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <ExternalLink className="size-3.5 text-sky-400" />
                            Open Locked Viewer
                          </DropdownMenuItem>

                          {log.driveUrl && (
                            <DropdownMenuItem
                              onClick={() => window.open(log.driveUrl!, "_blank")}
                              className="flex items-center gap-2 cursor-pointer"
                            >
                              <HardDrive className="size-3.5 text-emerald-400" />
                              Open on Drive
                            </DropdownMenuItem>
                          )}

                          <DropdownMenuItem
                            onClick={() => handleOpenSharing(log)}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <Share2 className="size-3.5 text-amber-400" />
                            Sharing Settings
                          </DropdownMenuItem>

                          <DropdownMenuItem
                            onClick={() => handleOpenEmail(log)}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <Mail className="size-3.5 text-rose-400" />
                            Send via Email
                          </DropdownMenuItem>

                          <DropdownMenuSeparator className="bg-neutral-800" />

                          <DropdownMenuItem
                            onClick={() => {
                              const a = document.createElement("a");
                              a.href = `/api/pdf/raw/${log.workerViewToken}?download=1`;
                              a.download = "";
                              a.click();
                            }}
                            className="flex items-center gap-2 cursor-pointer text-emerald-400"
                          >
                            <Download className="size-3.5" />
                            Download PDF
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* List View */
            <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-neutral-800/80 bg-neutral-900/60 text-neutral-400 text-[11px] uppercase tracking-wider font-semibold">
                    <th className="py-3 px-4">Document</th>
                    <th className="py-3 px-4">Location</th>
                    <th className="py-3 px-4">Size</th>
                    <th className="py-3 px-4">Pages</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/60">
                  {filteredLogs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => handleOpenDetails(log)}
                      className="hover:bg-neutral-900/80 transition-colors cursor-pointer group"
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 shrink-0">
                            <FileText className="size-4" />
                          </div>
                          <div>
                            <span className="font-semibold text-neutral-100 group-hover:text-sky-300 block truncate max-w-xs">
                              {log.title}
                            </span>
                            <span className="text-[11px] text-neutral-400 font-mono">
                              {log.id.slice(0, 16)}...
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {log.driveFileId ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10 text-[10px]"
                            >
                              <HardDrive className="size-2.5 mr-1" />
                              {log.driveFolderName || "Drive"}
                            </Badge>
                          ) : null}
                          {log.r2Key ? (
                            <Badge
                              variant="outline"
                              className="border-violet-500/30 text-violet-400 bg-violet-500/10 text-[10px]"
                            >
                              <Cloud className="size-2.5 mr-1" />
                              R2
                            </Badge>
                          ) : null}
                          <Badge
                            variant="outline"
                            className="border-sky-500/30 text-sky-400 bg-sky-500/10 text-[10px]"
                          >
                            <Lock className="size-2.5 mr-1" />
                            {log.workerViewMode}
                          </Badge>
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono text-neutral-300">
                        {formatBytes(log.byteSize)}
                      </td>

                      <td className="py-3 px-4 text-neutral-400">
                        {log.pageCount}
                      </td>

                      <td className="py-3 px-4 text-neutral-400">
                        {new Date(log.createdAt).toLocaleDateString()}
                      </td>

                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <a
                            href={`/gws/pdf-view/${log.workerViewToken}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="size-7 p-0 inline-flex items-center justify-center text-neutral-400 hover:text-neutral-100 rounded-md hover:bg-neutral-800 transition-colors"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => handleCopyLink(log, e)}
                            className="size-7 p-0 text-neutral-400 hover:text-neutral-100"
                          >
                            {copiedTokenId === log.id ? (
                              <Check className="size-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleOpenSharing(log)}
                            className="size-7 p-0 text-neutral-400 hover:text-amber-400"
                          >
                            <Share2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Modals & Dialogs */}
      <PdfTemplateBrowserDialog
        open={templateBrowserOpen}
        onOpenChange={setTemplateBrowserOpen}
        templates={templates}
        onSelectTemplate={handleSelectTemplate}
      />

      <PdfCreateModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        template={selectedTemplateForCreate}
        onSuccess={() => void loadData()}
      />

      <PdfDetailsSheet
        open={detailsSheetOpen}
        onOpenChange={setDetailsSheetOpen}
        record={activeRecord}
        onOpenSharing={handleOpenSharing}
        onOpenEmail={handleOpenEmail}
        onConvertedToTemplate={() => void loadData()}
      />

      <PdfSharingDialog
        open={sharingDialogOpen}
        onOpenChange={setSharingDialogOpen}
        record={activeRecord}
        onUpdateRecord={(updated) => {
          setActiveRecord(updated);
          void loadData();
        }}
      />

      <PdfDriveConvertModal
        open={driveConvertModalOpen}
        onOpenChange={setDriveConvertModalOpen}
        onSuccess={() => void loadData()}
      />

      <PdfEmailSendModal
        open={emailSendModalOpen}
        onOpenChange={setEmailSendModalOpen}
        record={activeRecord}
      />
    </div>
  );
}
