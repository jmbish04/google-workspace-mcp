/**
 * @fileoverview ScheduledSends — the /gws/scheduled-sends island.
 *
 * Lists the scheduled Gmail send queue (GET /api/gws/scheduled-sends), newest
 * schedule first. Not-yet-sent rows show a Cancel button gated behind a shadcn
 * AlertDialog confirm (NEVER window.confirm); already-sent rows show a "sent"
 * status and no action.
 *
 * Wire contract:
 *   GET  /api/gws/scheduled-sends                 -> { scheduledSends: ScheduledSend[] }
 *   POST /api/gws/scheduled-sends/:id/cancel      -> { ok: true, id } | 409 if already sent
 */

"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";
import { shortDate } from "@/lib/format";

/** One scheduled send, per the backend wire contract. */
export type ScheduledSend = {
  id: number;
  draftId: string;
  accountEmail: string | null;
  accountRef: string;
  cron: string;
  sent: boolean;
  sentMessageId: string | null;
  error: string | null;
  createdAt: string | number;
  sentAt: string | number | null;
};

/** Build auth headers from the session token (Bearer). Cookie is also sent same-origin. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function ScheduledSends() {
  const [rows, setRows] = React.useState<ScheduledSend[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [errored, setErrored] = React.useState(false);
  const [busyId, setBusyId] = React.useState<number | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<ScheduledSend | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setErrored(false);
    try {
      const data = await fetchJson<{ scheduledSends: ScheduledSend[] }>(
        "/api/gws/scheduled-sends",
        { headers: authHeaders() },
        { source: "scheduled-sends:list", friendly: "Couldn't load the scheduled send queue." },
      );
      setRows(data.scheduledSends ?? []);
    } catch {
      setErrored(true); // fetchJson already logged to the global ErrorLogger
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleCancel = React.useCallback(async (row: ScheduledSend) => {
    setBusyId(row.id);
    try {
      await fetchJson(
        `/api/gws/scheduled-sends/${row.id}/cancel`,
        { method: "POST", headers: authHeaders() },
        { source: "scheduled-sends:cancel", friendly: "Couldn't cancel that scheduled send." },
      );
      setRows((prev) => (prev ? prev.filter((r) => r.id !== row.id) : prev));
      setCancelTarget(null);
    } catch {
      /* logged by fetchJson; leave the row in place */
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="font-mono text-[11px]">
          {rows ? `${rows.length} scheduled` : "…"}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          Refresh
        </Button>
      </div>

      {errored ? (
        <p className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-border/40">
          Couldn&apos;t load the queue. <a href="/auth/google" className="text-primary hover:underline">Sign in</a> and try again.
        </p>
      ) : loading && !rows ? (
        <p className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-border/40">
          Loading scheduled sends…
        </p>
      ) : rows && rows.length === 0 ? (
        <p className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-border/40">
          No scheduled sends yet. Create a draft, then schedule it with the{" "}
          <code className="text-primary">gmail_schedule_send</code> tool.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border/40">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Cron (UTC)</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows?.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-sm">
                    {row.accountEmail ?? <span className="font-mono text-xs text-muted-foreground">{row.accountRef}</span>}
                    <div className="font-mono text-[10px] text-muted-foreground">draft {row.draftId}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.cron}</TableCell>
                  <TableCell className="text-muted-foreground" title={String(row.createdAt)}>
                    {shortDate(row.createdAt)}
                  </TableCell>
                  <TableCell>
                    {row.sent ? (
                      <Badge variant="secondary" className="font-mono text-[10px]" title={row.sentAt ? String(row.sentAt) : undefined}>
                        sent
                      </Badge>
                    ) : row.error ? (
                      <Badge variant="destructive" className="font-mono text-[10px]" title={row.error}>
                        pending (last error)
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        pending
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.sent ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => setCancelTarget(row)}
                      >
                        <Trash2 className="size-4" />
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Cancel confirm — shadcn AlertDialog, NEVER window.confirm */}
      <AlertDialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this scheduled send?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelTarget
                ? `The draft (${cancelTarget.draftId}) on schedule "${cancelTarget.cron}" will be removed from the queue and won't be sent automatically. The draft itself stays in Gmail — you can reschedule it later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyId !== null}
              onClick={() => {
                if (cancelTarget) void handleCancel(cancelTarget);
              }}
            >
              <Trash2 className="size-4" />
              Cancel send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
