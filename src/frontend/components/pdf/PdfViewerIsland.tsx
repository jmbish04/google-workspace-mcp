/**
 * @file src/frontend/components/pdf/PdfViewerIsland.tsx
 * @description Locked-down, secure PDF recipient viewer.
 * The recipient can ONLY view the single shared document and nothing else.
 * Supports direct PDF binary streaming, Google Drive iframe embed preview,
 * and policy-enforced downloading.
 */
import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Download,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
  HardDrive,
  Eye,
  Lock,
  Sparkles,
} from "lucide-react";

interface PdfViewerIslandProps {
  token: string;
}

interface ViewMetadata {
  id: string;
  title: string;
  byteSize: number;
  pageCount: number;
  workerViewMode: "direct-worker" | "drive-embed";
  allowDownload: boolean;
  driveUrl?: string | null;
  r2ShareUrl?: string | null;
  rawStreamUrl: string;
  createdAt: string;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function PdfViewerIsland({ token }: PdfViewerIslandProps) {
  const [data, setData] = useState<ViewMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeEngine, setActiveEngine] = useState<"direct-worker" | "drive-embed">("direct-worker");

  useEffect(() => {
    let unmounted = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/pdf/view/${token}`);
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "This document was not found or the secure link has expired."
              : `Server returned status ${res.status}`
          );
        }
        const json = (await res.json()) as ViewMetadata;
        if (!unmounted) {
          setData(json);
          setActiveEngine(json.workerViewMode || "direct-worker");
        }
      } catch (err: any) {
        if (!unmounted) {
          setError(err.message || "Failed to load document");
        }
      } finally {
        if (!unmounted) setLoading(false);
      }
    };
    void load();
    return () => {
      unmounted = true;
    };
  }, [token]);

  // Compute Google Drive embed URL
  const driveEmbedUrl = React.useMemo(() => {
    if (!data?.driveUrl) return null;
    // Match /d/([a-zA-Z0-9_-]+) or id=([a-zA-Z0-9_-]+)
    const match = data.driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || data.driveUrl.match(/id=([a-zA-Z0-9_-]+)/);
    if (match?.[1]) {
      return `https://drive.google.com/file/d/${match[1]}/preview`;
    }
    return data.driveUrl;
  }, [data?.driveUrl]);

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center text-neutral-400 space-y-3">
        <Sparkles className="size-8 text-sky-400 animate-spin" />
        <p className="text-xs">Loading secure document viewer...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6 text-neutral-100">
        <div className="max-w-md w-full p-6 rounded-2xl border border-neutral-800 bg-neutral-900/60 text-center space-y-4">
          <div className="size-12 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
            <AlertCircle className="size-6" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-neutral-200">Access Restricted</h2>
            <p className="text-xs text-neutral-400 mt-1.5">{error || "Document not found"}</p>
          </div>
          <div className="p-3 rounded-lg border border-neutral-800 bg-neutral-950 text-neutral-500 text-[11px] flex items-center justify-center gap-1.5">
            <Lock className="size-3.5" />
            Locked-Down Document Link
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col text-neutral-100 antialiased selection:bg-sky-500/30">
      {/* Top Navigation Bar */}
      <header className="h-14 shrink-0 border-b border-neutral-800/80 bg-neutral-900/40 px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Document Title & Badge */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20 shrink-0">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-neutral-100 truncate">
              {data.title}
            </h1>
            <p className="text-[11px] text-neutral-400 flex items-center gap-2">
              <span>{formatBytes(data.byteSize)}</span>
              <span>•</span>
              <span>{data.pageCount} {data.pageCount === 1 ? "page" : "pages"}</span>
              <span>•</span>
              <span className="flex items-center gap-1 text-sky-400">
                <ShieldCheck className="size-3" />
                Verified View Link
              </span>
            </p>
          </div>
        </div>

        {/* Engine switcher & actions */}
        <div className="flex items-center gap-2">
          {driveEmbedUrl && (
            <div className="hidden sm:flex items-center border border-neutral-800 rounded-lg p-0.5 bg-neutral-900/60">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActiveEngine("direct-worker")}
                className={`h-7 px-2.5 text-xs rounded-md ${
                  activeEngine === "direct-worker"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <Eye className="size-3 mr-1" />
                Worker Direct
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActiveEngine("drive-embed")}
                className={`h-7 px-2.5 text-xs rounded-md ${
                  activeEngine === "drive-embed"
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <HardDrive className="size-3 mr-1 text-emerald-400" />
                Drive Preview
              </Button>
            </div>
          )}

          {data.allowDownload ? (
            <a
              href={`${data.rawStreamUrl}?download=1`}
              download
              className="h-8 inline-flex items-center justify-center bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 rounded-md shadow-sm transition-colors"
            >
              <Download className="size-3.5 mr-1.5" />
              Download PDF
            </a>
          ) : (
            <Badge
              variant="outline"
              className="border-neutral-800 bg-neutral-900/80 text-neutral-400 text-xs px-2.5 py-1 flex items-center gap-1.5"
            >
              <Lock className="size-3" />
              View Only
            </Badge>
          )}
        </div>
      </header>

      {/* Main PDF Viewport */}
      <main className="flex-1 w-full p-2 sm:p-4 flex flex-col">
        <div className="flex-1 w-full max-w-7xl mx-auto rounded-xl border border-neutral-800/80 bg-neutral-900/30 overflow-hidden shadow-2xl flex flex-col">
          {activeEngine === "drive-embed" && driveEmbedUrl ? (
            <iframe
              src={driveEmbedUrl}
              title={data.title}
              className="w-full h-full min-h-[calc(100vh-6rem)] border-0 rounded-xl"
              allow="autoplay"
            />
          ) : (
            <object
              data={data.rawStreamUrl}
              type="application/pdf"
              className="w-full h-full min-h-[calc(100vh-6rem)] border-0 rounded-xl"
            >
              <iframe
                src={data.rawStreamUrl}
                title={data.title}
                className="w-full h-full min-h-[calc(100vh-6rem)] border-0 rounded-xl"
              >
                <div className="p-8 text-center text-xs text-neutral-400 space-y-3">
                  <p>Your browser does not support inline PDF viewing.</p>
                  {data.allowDownload && (
                    <a
                      href={`${data.rawStreamUrl}?download=1`}
                      className="inline-flex items-center justify-center h-8 px-3 rounded-md bg-sky-600 text-white text-xs font-medium"
                    >
                      Download PDF
                    </a>
                  )}
                </div>
              </iframe>
            </object>
          )}
        </div>
      </main>
    </div>
  );
}
