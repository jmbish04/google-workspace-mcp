/**
 * @fileoverview DraftList — the `/gws/draft-studio` index island.
 *
 * Studio drafts, newest-updated first, with a "New draft" button so a draft can
 * be started here as well as from the agent. Plain fetch only (no PlateJS), so
 * `client:load` is fine.
 *
 * Wire contract:
 *   GET  /api/email-drafts?status=drafting,in_gmail -> { drafts: EmailDraftRow[] }
 *   POST /api/email-drafts                          -> DraftWithHistory
 */

"use client";

import { Loader2, Plus, RefreshCw } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet, apiSend } from "@/lib/api";
import { logError } from "@/lib/error-log";
import { relativeTime } from "@/lib/format";

import { STATUS_LABEL, type DraftWithHistory, type EmailDraftRow } from "./types";

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  drafting: "default",
  in_gmail: "secondary",
  sent: "outline",
  discarded: "destructive",
};

export function DraftList() {
  const [drafts, setDrafts] = React.useState<EmailDraftRow[] | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const out = await apiGet<{ drafts: EmailDraftRow[] }>(
        "email-drafts",
        showAll ? undefined : { status: "drafting,in_gmail" },
      );
      setDrafts(out.drafts);
      setError(null);
    } catch (err) {
      logError({ title: "Could not load drafts", message: (err as Error).message, detail: err, source: "DraftList.load" });
      setError(`Could not load drafts: ${(err as Error).message}`);
      setDrafts([]);
    }
  }, [showAll]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const draft = await apiSend<DraftWithHistory>("POST", "email-drafts", { subject: "", note: "Started on the page" });
      window.location.href = `/gws/draft-studio/${draft.id}`;
    } catch (err) {
      logError({ title: "Could not start a draft", message: (err as Error).message, detail: err, source: "DraftList.create" });
      setError(`Could not start a draft: ${(err as Error).message}`);
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={create} disabled={creating}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} New draft
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show active only" : "Show sent and discarded"}
        </Button>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {drafts === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No drafts yet. Ask the agent to “draft that in the studio”, or start one here.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Rev</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drafts.map((d) => (
              <TableRow
                key={d.id}
                className="cursor-pointer"
                onClick={() => {
                  window.location.href = `/gws/draft-studio/${d.id}`;
                }}
              >
                <TableCell className="font-medium">
                  <a href={`/gws/draft-studio/${d.id}`}>{d.subject || "(no subject)"}</a>
                </TableCell>
                <TableCell className="text-muted-foreground">{d.toAddr || "—"}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{d.currentRevision}</TableCell>
                <TableCell className="text-right text-muted-foreground">{relativeTime(d.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default DraftList;
