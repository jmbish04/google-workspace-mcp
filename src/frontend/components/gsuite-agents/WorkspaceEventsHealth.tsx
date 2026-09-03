/**
 * @fileoverview WorkspaceEventsHealth — island for `/gws/events-health`.
 *
 * Triggers POST `/api/gws-health-check/run-e2e` (create a folder, subscribe,
 * create/rename/comment/delete a Doc, then poll D1 for Pub/Sub webhook rows) and lists prior runs
 * from GET `/api/gws-health-check/results`. Auth is the `gsuite_session` cookie
 * (AuthGate on the page) or a Bearer key. `loadHistory` waits for
 * `GET /api/agent-session/session` before calling `/results` so a locked or
 * still-checking AuthGate is not reported as a failed history fetch. Errors go through
 * `useFrontendErrorHandler` + `FrontendErrorDialog` — never `window.alert`.
 */

"use client";

import { ActivityIcon, CheckCircle2Icon, Loader2Icon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CopyButton } from "@/components/CopyButton";
import { FrontendErrorDialog } from "@/components/FrontendErrorDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiSend, ApiError } from "@/lib/api";
import { type FrontendErrorPayload, useFrontendErrorHandler } from "@/lib/error-handler";
import { hasAgentSession } from "@/lib/session";
import { cn } from "@/lib/utils";

type StepResult = {
  action: string;
  status: "ok" | "fail";
  durationMs?: number;
  docId?: string;
  subscriptionName?: string;
  count?: number;
  events?: unknown[];
  eventTypes?: string[];
  families?: string[];
  error?: string;
};

type RunResult = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "fail";
  health?: "healthy" | "degraded" | "unhealthy" | "unknown";
  docId: string | null;
  results: StepResult[];
};

const ACTION_LABELS: Record<string, string> = {
  folder: "Create test folder",
  subscribe: "Subscribe to file events",
  create: "Create Google Doc",
  rename: "Rename Doc",
  comment: "Add Comment",
  delete: "Delete Doc",
  monitor: "Monitor webhook events",
};

const pageFile = "src/frontend/components/gsuite-agents/WorkspaceEventsHealth.tsx";

function errorPayload(
  functionName: string,
  description: string,
  friendlyError: string,
  serverError: unknown,
): FrontendErrorPayload {
  return {
    sourcePage: {
      url: typeof window !== "undefined" ? window.location.href : "/gws/events-health",
      file: "src/frontend/pages/gws/events-health.astro",
    },
    codeSource: { file: pageFile, functionName, description },
    errorDetails: { friendlyError, serverError },
  };
}

export function WorkspaceEventsHealth() {
  const { activeError, clearError, copyErrorPrompt, copyState, handleError } =
    useFrontendErrorHandler();
  const [loading, setLoading] = useState(false);
  const [currentRun, setCurrentRun] = useState<RunResult | null>(null);
  const [history, setHistory] = useState<RunResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryFailed(false);
    try {
      // AuthGate is a sibling island (`authed={false}`), so this page hydrates
      // before the session cookie exists. Hitting /results then 401s and used
      // to open the error dialog for a normal locked/checking gate.
      if (!(await hasAgentSession())) return;
      const data = await apiGet<{ runs: RunResult[] }>("/gws-health-check/results", { limit: 5 });
      setHistory(data.runs ?? []);
    } catch (err) {
      setHistoryFailed(true);
      handleError(
        errorPayload(
          "loadHistory",
          "Loads recent Workspace Events E2E runs from GET /api/gws-health-check/results.",
          "Could not load previous health-check runs.",
          err instanceof ApiError ? err.body ?? err.message : err,
        ),
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const runTest = useCallback(async () => {
    if (!(await hasAgentSession())) return;
    setLoading(true);
    setCurrentRun(null);
    setShowEvents(false);
    try {
      const data = await apiSend<RunResult>("POST", "/gws-health-check/run-e2e");
      setCurrentRun(data);
      void loadHistory();
    } catch (err) {
      handleError(
        errorPayload(
          "runTest",
          "Triggers POST /api/gws-health-check/run-e2e (folder subscribe + create/rename/comment/delete Doc + poll webhooks).",
          "The Workspace Events E2E test did not complete. Sign in if prompted, then retry.",
          err instanceof ApiError ? err.body ?? err.message : err,
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [handleError, loadHistory]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <FrontendErrorDialog
        error={activeError}
        copyState={copyState}
        onCopyPrompt={copyErrorPrompt}
        onOpenChange={(open) => {
          if (!open) clearError();
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ActivityIcon className="size-5" /> Workspace Events Health
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Creates a folder, subscribes to its descendants, then creates /
            renames / comments / deletes a Doc and verifies Pub/Sub events arrived
            at <code className="text-primary">/api/webhooks/workspace</code>.
            Typically 20–60 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void runTest()} disabled={loading} size="lg">
            {loading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            {loading ? "Running…" : "Run E2E test"}
          </Button>
          <Button type="button" variant="outline" onClick={() => void loadHistory()} disabled={historyLoading}>
            {historyLoading ? "Loading…" : "Refresh history"}
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="bg-card ring-1 ring-border/40">
          <CardContent className="space-y-3 py-8">
            <div className="flex justify-center">
              <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
            </div>
            <p className="text-center text-sm text-muted-foreground">
              Mutating Drive, then polling D1 for webhook events…
            </p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : null}

      {currentRun ? (
        <RunCard
          run={currentRun}
          showEvents={showEvents}
          onToggleEvents={() => setShowEvents((v) => !v)}
        />
      ) : null}

      {history.length > 0 ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Recent runs</h2>
          {history.map((run) => (
            <RunCard key={run.runId} run={run} compact />
          ))}
        </div>
      ) : historyLoading ? (
        <Card className="bg-card ring-1 ring-border/40">
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      ) : historyFailed ? (
        <Card className="bg-card ring-1 ring-destructive/30">
          <CardContent className="p-6 text-sm text-muted-foreground">
            Previous runs could not be loaded. Use the error dialog to copy
            details, then retry Refresh history.
          </CardContent>
        </Card>
      ) : !currentRun && !loading ? (
        <Card className="bg-card ring-1 ring-border/40">
          <CardContent className="p-6 text-sm text-muted-foreground">
            No runs yet. Trigger a test from this page or via the
            {" "}
            <code className="text-primary">run_workspace_e2e_test</code> MCP tool.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function RunCard({
  run,
  showEvents,
  onToggleEvents,
  compact,
}: {
  run: RunResult;
  showEvents?: boolean;
  onToggleEvents?: () => void;
  compact?: boolean;
}) {
  const monitorStep = run.results?.find((r) => r.action === "monitor");
  const ok = run.status === "ok";
  const StatusIcon = ok ? CheckCircle2Icon : XCircleIcon;

  return (
    <Card className={cn("bg-card ring-1", ok ? "ring-emerald-500/30" : "ring-destructive/30")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className={cn("flex items-center gap-2", compact ? "text-base" : "text-lg")}>
            <StatusIcon className={cn("size-5", ok ? "text-emerald-500" : "text-destructive")} />
            {ok ? "Pipeline healthy" : "Pipeline issue detected"}
          </CardTitle>
          <Badge variant={ok ? "default" : "destructive"}>
            {(run.health ?? run.status).toUpperCase()}
          </Badge>
        </div>
        {!compact && run.startedAt ? (
          <p className="text-xs text-muted-foreground">
            {new Date(run.startedAt).toLocaleString()}
            {run.finishedAt ? (
              <>
                {" · "}
                {((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1)}s total
              </>
            ) : null}
            {run.docId ? <> · doc {run.docId}</> : null}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {run.results?.map((step, i) => (
          <div
            key={`${step.action}-${i}`}
            className="flex items-center justify-between rounded-md bg-muted/20 px-3 py-2 ring-1 ring-border/40"
          >
            <div className="flex items-center gap-2">
              {step.status === "ok" ? (
                <CheckCircle2Icon className="size-4 text-emerald-500" />
              ) : (
                <XCircleIcon className="size-4 text-destructive" />
              )}
              <span className="text-sm font-medium">{ACTION_LABELS[step.action] ?? step.action}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {step.durationMs !== undefined ? <span>{step.durationMs}ms</span> : null}
              {step.action === "monitor" && step.count !== undefined ? (
                <Badge variant="outline" className="text-xs">
                  {step.count} event{step.count !== 1 ? "s" : ""}
                </Badge>
              ) : null}
            </div>
          </div>
        ))}

        {monitorStep?.eventTypes && monitorStep.eventTypes.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Types: {monitorStep.eventTypes.join(", ")}
          </p>
        ) : null}

        {!compact && monitorStep?.events?.length ? (
          <div className="mt-3 space-y-2">
            <button
              type="button"
              onClick={onToggleEvents}
              className="text-xs font-medium text-primary hover:underline"
            >
              {showEvents ? "Hide event details" : "Show event details"}
            </button>
            {showEvents ? (
              <pre className="max-h-60 overflow-auto rounded-md bg-muted/30 p-3 text-xs ring-1 ring-border/40">
                {JSON.stringify(monitorStep.events, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}

        {run.results?.some((r) => r.error) ? (
          <div className="mt-2 space-y-1">
            {run.results
              .filter((r) => r.error)
              .map((r, i) => (
                <p key={i} className="text-xs text-destructive">
                  {ACTION_LABELS[r.action] ?? r.action}: {r.error}
                </p>
              ))}
          </div>
        ) : null}

        {!compact ? (
          <div className="pt-2">
            <CopyButton label="Copy run JSON" copiedLabel="Copied" text={JSON.stringify(run, null, 2)} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
