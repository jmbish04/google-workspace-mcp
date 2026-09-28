/**
 * @file src/frontend/components/pdf/PdfEmailSendModal.tsx
 * @description Dialog modal for effortlessly attaching a generated PDF or Drive file
 * to an email via Gmail API, with direct MIME attachment and/or styled Google Drive share links.
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Paperclip,
  HardDrive,
  Send,
  Check,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import type { PdfGenerationLog } from "@/backend/db/schemas/pdf-generation-logs";

interface PdfEmailSendModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: PdfGenerationLog | null;
  onSuccess?: () => void;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function PdfEmailSendModal({
  open,
  onOpenChange,
  record,
  onSuccess,
}: PdfEmailSendModalProps) {
  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"mime-attachment" | "drive-link" | "both">(
    "mime-attachment"
  );
  const [driveFileId, setDriveFileId] = useState("");

  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (record) {
      setSubject(`Document Attached: ${record.title}`);
      setMessage(
        `Hi,\n\nPlease find attached the document "${record.title}".\n\nBest regards,`
      );
      setDriveFileId(record.driveFileId || "");
      if (!record.driveFileId) {
        setDeliveryMode("mime-attachment");
      }
    } else {
      setSubject("Attached Document");
      setMessage("Hi,\n\nPlease find attached the requested document.\n\nBest regards,");
      setDriveFileId("");
    }
    setSendSuccess(null);
    setErrorMsg(null);
  }, [record, open]);

  const handleSend = async () => {
    if (!toEmail.trim() || !subject.trim()) {
      setErrorMsg("Please provide recipient email and subject");
      return;
    }

    setIsSending(true);
    setErrorMsg(null);
    setSendSuccess(null);

    try {
      let pdfBase64: string | undefined;

      // If we have a record and need mime-attachment or both, fetch raw bytes or let backend resolve
      if (record && (deliveryMode === "mime-attachment" || deliveryMode === "both")) {
        // Fetch raw bytes from /api/pdf/raw/:token
        const res = await fetch(`/api/pdf/raw/${record.workerViewToken}`);
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let bin = "";
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          pdfBase64 = btoa(bin);
        }
      }

      await fetchJson(
        "/api/pdf/email-send",
        {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            to: toEmail.trim(),
            subject: subject.trim(),
            bodyText: message,
            filename: record?.title ? `${record.title.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf` : "document.pdf",
            pdfBase64,
            driveFileId: driveFileId.trim() || record?.driveFileId || undefined,
            deliveryMode,
          }),
        },
        { source: "pdf-email:send", friendly: "Failed sending email with attachment" }
      );

      setSendSuccess(`Email successfully sent to ${toEmail}!`);
      if (onSuccess) {
        onSuccess();
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to send email");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg bg-neutral-950 border-neutral-800 text-neutral-100 p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-neutral-800/80 bg-neutral-900/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <Mail className="size-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-neutral-100">
                Send PDF via Email
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-400 mt-0.5">
                Directly attach the PDF file or drop a viewable Google Drive link into the email.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {sendSuccess ? (
            <div className="py-6 text-center space-y-3">
              <div className="size-12 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <Check className="size-6" />
              </div>
              <h4 className="text-sm font-semibold text-neutral-100">Email Dispatched!</h4>
              <p className="text-xs text-neutral-400 max-w-sm mx-auto">{sendSuccess}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-neutral-300">Recipient Email (To:)</Label>
                <Input
                  type="email"
                  placeholder="recipient@example.com"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                />
              </div>

              <div>
                <Label className="text-xs text-neutral-300">Subject</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="h-9 mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200"
                />
              </div>

              <div>
                <Label className="text-xs text-neutral-300">Message Body</Label>
                <Textarea
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="mt-1 bg-neutral-950 border-neutral-800 text-xs text-neutral-200 resize-none font-sans"
                />
              </div>

              {/* Delivery Mode Selection */}
              <div className="space-y-2 pt-1">
                <Label className="text-xs font-medium text-neutral-300 uppercase tracking-wider block">
                  Attachment & Delivery Mode
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setDeliveryMode("mime-attachment")}
                    className={`p-2.5 rounded-lg border text-left flex flex-col gap-1 transition-colors ${
                      deliveryMode === "mime-attachment"
                        ? "border-rose-500/50 bg-rose-500/10 text-rose-300"
                        : "border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:bg-neutral-800/50"
                    }`}
                  >
                    <Paperclip className="size-4" />
                    <span className="text-xs font-medium">MIME Attachment</span>
                    <span className="text-[10px] text-neutral-500">Direct PDF file</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeliveryMode("drive-link")}
                    className={`p-2.5 rounded-lg border text-left flex flex-col gap-1 transition-colors ${
                      deliveryMode === "drive-link"
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                        : "border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:bg-neutral-800/50"
                    }`}
                  >
                    <HardDrive className="size-4" />
                    <span className="text-xs font-medium">Drive Link</span>
                    <span className="text-[10px] text-neutral-500">Anyone with link</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeliveryMode("both")}
                    className={`p-2.5 rounded-lg border text-left flex flex-col gap-1 transition-colors ${
                      deliveryMode === "both"
                        ? "border-sky-500/50 bg-sky-500/10 text-sky-300"
                        : "border-neutral-800 bg-neutral-900/40 text-neutral-400 hover:bg-neutral-800/50"
                    }`}
                  >
                    <Sparkles className="size-4" />
                    <span className="text-xs font-medium">Both</span>
                    <span className="text-[10px] text-neutral-500">Attachment + Link</span>
                  </button>
                </div>
              </div>

              {/* Document Summary Pill */}
              {record && (
                <div className="p-2.5 rounded-lg border border-neutral-800 bg-neutral-900/40 flex items-center justify-between text-xs">
                  <span className="text-neutral-400 truncate max-w-[260px]">
                    Attached: <strong className="text-neutral-200">{record.title}</strong>
                  </span>
                  <Badge variant="outline" className="text-[10px] border-neutral-800 text-neutral-400">
                    {record.byteSize ? `${(record.byteSize / 1024).toFixed(1)} KB` : "0 KB"}
                  </Badge>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="p-4 border-t border-neutral-800 bg-neutral-900/40 flex justify-between items-center">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-neutral-400 hover:text-neutral-200 text-xs"
          >
            {sendSuccess ? "Close" : "Cancel"}
          </Button>

          {!sendSuccess && (
            <Button
              onClick={handleSend}
              disabled={isSending || !toEmail.trim() || !subject.trim()}
              className="bg-rose-600 hover:bg-rose-500 text-white text-xs h-9"
            >
              {isSending ? (
                <span className="flex items-center gap-2">
                  <Sparkles className="size-3.5 animate-spin" />
                  Sending via Gmail...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Send className="size-3.5" />
                  Send Email
                </span>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
