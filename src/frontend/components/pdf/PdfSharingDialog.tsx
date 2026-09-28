/**
 * @file src/frontend/components/pdf/PdfSharingDialog.tsx
 * @description Retrofitted @reui/dialog-2 sharing and permissions modal.
 * Manages Google Drive sharing settings (anyone-viewer, restricted, invite user),
 * presentation mode (direct worker vs drive embed), download permissions,
 * and quick copyable links.
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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Share2,
  Copy,
  Check,
  Globe,
  Lock,
  Download,
  Eye,
  ExternalLink,
  Users,
  HardDrive,
  Cloud,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";

interface PdfSharingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: PdfGenerationLog | null;
  onUpdateRecord?: (updated: PdfGenerationLog) => void;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function PdfSharingDialog({
  open,
  onOpenChange,
  record,
  onUpdateRecord,
}: PdfSharingDialogProps) {
  if (!record) return null;

  const [shareType, setShareType] = useState<"anyone" | "user">("anyone");
  const [shareRole, setShareRole] = useState<"reader" | "commenter" | "writer">("reader");
  const [inviteEmail, setInviteEmail] = useState("");
  const [workerViewMode, setWorkerViewMode] = useState<string>(
    record.workerViewMode || "direct-worker"
  );
  const [allowDownload, setAllowDownload] = useState<boolean>(record.allowDownload ?? true);
  const [isSavingDrive, setIsSavingDrive] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [driveSuccess, setDriveSuccess] = useState<string | null>(null);

  const lockedDownUrl = typeof window !== "undefined"
    ? `${window.location.origin}/gws/pdf-view/${record.workerViewToken}`
    : `/gws/pdf-view/${record.workerViewToken}`;

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleApplyDriveSharing = async () => {
    if (!record.driveFileId) return;
    setIsSavingDrive(true);
    setDriveSuccess(null);
    try {
      await fetchJson(
        "/api/pdf/sharing",
        {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            fileId: record.driveFileId,
            type: shareType,
            role: shareRole,
            emailAddress: shareType === "user" ? inviteEmail.trim() : undefined,
          }),
        },
        { source: "pdf-sharing:update", friendly: "Failed to update Drive sharing settings" }
      );
      setDriveSuccess(
        shareType === "anyone"
          ? `Updated: Anyone with the link is now a ${shareRole}`
          : `Invitation sent to ${inviteEmail} as ${shareRole}`
      );
      if (onUpdateRecord) {
        onUpdateRecord({
          ...record,
          driveSharingRole: shareType === "anyone" ? `anyone-${shareRole}` : `user-${shareRole}`,
        });
      }
    } catch {
      // logged by fetchJson
    } finally {
      setIsSavingDrive(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-neutral-950 border-neutral-800 text-neutral-100 p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-neutral-800/80 bg-neutral-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Share2 className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-neutral-100">
                Sharing & Access Control
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-400 mt-0.5 truncate max-w-sm">
                {record.title}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          {/* Quick Copy Links */}
          <div className="space-y-3">
            <Label className="text-xs font-medium text-neutral-300 uppercase tracking-wider">
              Shareable Links
            </Label>

            {/* Worker Locked-Down Link */}
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium text-sky-400">
                  <Lock className="size-3.5" />
                  Locked-Down Viewer Link
                </span>
                <Badge variant="outline" className="text-[10px] border-sky-500/30 text-sky-300">
                  Recipient View-Only
                </Badge>
              </div>
              <p className="text-[11px] text-neutral-400">
                Isolated view token. Recipient can only access this document.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Input
                  readOnly
                  value={lockedDownUrl}
                  className="h-8 text-xs font-mono bg-neutral-950/80 border-neutral-800 text-neutral-300"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(lockedDownUrl, "worker")}
                  className="h-8 shrink-0 border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                >
                  {copiedKey === "worker" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                </Button>
                <a
                  href={lockedDownUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-8 shrink-0 flex items-center justify-center px-2 text-neutral-400 hover:text-neutral-100 rounded-md hover:bg-neutral-800 transition-colors"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            </div>

            {/* Google Drive Link if synced */}
            {record.driveUrl && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-emerald-400">
                    <HardDrive className="size-3.5" />
                    Google Drive Direct URL
                  </span>
                  <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-300">
                    {record.driveSharingRole || "Drive Link"}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    readOnly
                    value={record.driveUrl}
                    className="h-8 text-xs font-mono bg-neutral-950/80 border-neutral-800 text-neutral-300"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCopy(record.driveUrl!, "drive")}
                    className="h-8 shrink-0 border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                  >
                    {copiedKey === "drive" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  </Button>
                  <a
                    href={record.driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 shrink-0 flex items-center justify-center px-2 text-neutral-400 hover:text-neutral-100 rounded-md hover:bg-neutral-800 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )}

            {/* R2 Share URL if saved */}
            {record.r2ShareUrl && (
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium text-violet-400">
                    <Cloud className="size-3.5" />
                    Cloudflare R2 Direct CDN URL
                  </span>
                  <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-300">
                    Public R2
                  </Badge>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    readOnly
                    value={record.r2ShareUrl}
                    className="h-8 text-xs font-mono bg-neutral-950/80 border-neutral-800 text-neutral-300"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCopy(record.r2ShareUrl!, "r2")}
                    className="h-8 shrink-0 border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                  >
                    {copiedKey === "r2" ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Google Drive Sharing Controls */}
          {record.driveFileId ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-neutral-200 flex items-center gap-2">
                    <Users className="size-4 text-emerald-400" />
                    Google Drive Sharing Policy
                  </h4>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    Update permissions on the file in Google Drive.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-neutral-400">Share With</Label>
                  <Select value={shareType} onValueChange={(val: any) => setShareType(val)}>
                    <SelectTrigger className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-neutral-900 border-neutral-800 text-neutral-200">
                      <SelectItem value="anyone">Anyone with link</SelectItem>
                      <SelectItem value="user">Specific email address</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-neutral-400">Permission Role</Label>
                  <Select value={shareRole} onValueChange={(val: any) => setShareRole(val)}>
                    <SelectTrigger className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-neutral-900 border-neutral-800 text-neutral-200">
                      <SelectItem value="reader">Viewer (Read-only)</SelectItem>
                      <SelectItem value="commenter">Commenter</SelectItem>
                      <SelectItem value="writer">Editor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {shareType === "user" && (
                <div>
                  <Label className="text-xs text-neutral-400">Google Account Email</Label>
                  <Input
                    type="email"
                    placeholder="colleague@domain.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                  />
                </div>
              )}

              {driveSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-2">
                  <Check className="size-4 shrink-0" />
                  {driveSuccess}
                </div>
              )}

              <Button
                size="sm"
                onClick={handleApplyDriveSharing}
                disabled={isSavingDrive || (shareType === "user" && !inviteEmail.trim())}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-9"
              >
                {isSavingDrive ? "Updating Drive Permissions..." : "Apply Drive Permissions"}
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-neutral-800 p-4 text-center">
              <HardDrive className="size-6 text-neutral-600 mx-auto mb-1.5" />
              <p className="text-xs text-neutral-400">This PDF was not synced to Google Drive at creation time.</p>
            </div>
          )}

          {/* Worker Viewer Controls */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-4">
            <h4 className="text-sm font-medium text-neutral-200 flex items-center gap-2">
              <Eye className="size-4 text-sky-400" />
              Locked-Down Viewer Options
            </h4>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-neutral-300">Allow Direct Download</Label>
                <p className="text-[11px] text-neutral-400">
                  Recipients can download the raw PDF file from the viewer.
                </p>
              </div>
              <Switch
                checked={allowDownload}
                onCheckedChange={setAllowDownload}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-neutral-800/80">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium text-neutral-300">Viewer Rendering Engine</Label>
                <p className="text-[11px] text-neutral-400">
                  Choose between Cloudflare direct streaming or Google Drive iframe preview.
                </p>
              </div>
              <Select value={workerViewMode} onValueChange={(val: any) => { if (val) setWorkerViewMode(val); }}>
                <SelectTrigger className="h-8 w-36 bg-neutral-950 border-neutral-800 text-xs text-neutral-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-neutral-900 border-neutral-800 text-neutral-200">
                  <SelectItem value="direct-worker">Worker Direct</SelectItem>
                  <SelectItem value="drive-embed" disabled={!record.driveUrl}>
                    Drive Embed
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter className="p-4 border-t border-neutral-800 bg-neutral-900/40 flex justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs"
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
