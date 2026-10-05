/**
 * @fileoverview DraftStudio — the `/gws/draft-studio/[id]` island.
 *
 * An email revised here instead of in Gmail. The agent pushes numbered
 * revisions over MCP and this page updates live; the human reads the exact
 * HTML that would be sent, diffs it against any earlier revision, edits it in
 * the Tiptap editor, or highlights a passage and leaves a comment for the
 * agent. Only "Send" or "Put in Gmail" involves Gmail at all.
 *
 * MUST mount `client:only="react"` — Tiptap/ProseMirror are browser-only and
 * throw during Astro SSR.
 *
 * Wire contract:
 *   GET   /api/email-drafts/:id                  -> DraftWithHistory
 *   PATCH /api/email-drafts/:id                  -> DraftWithHistory
 *   POST  /api/email-drafts/:id/revisions        -> { revision, report }
 *   POST  /api/email-drafts/:id/comments         -> DraftComment
 *   POST  /api/email-drafts/:id/comments/resolve -> { resolved }
 *   POST  /api/email-drafts/:id/gmail-draft      -> { gmailDraftId, revision }
 *   POST  /api/email-drafts/:id/send             -> { messageId, threadId }
 *   GET   /api/email-drafts/:id/ws               (WebSocket)
 */

"use client";

import { useEditor } from "@tiptap/react";
import { Check, Loader2, MessageSquarePlus, Save, Send, Sparkles, Trash2, X } from "lucide-react";
import * as React from "react";

// The ReUI rich-text-editor-1 "kit": the shipped formatting toolbar, link
// bubble, editing surface and extension preset — composed here into the
// email-body assembly (no page-level document header/footer, which carry demo
// collaborators and a fake title that do not belong on an email).
import { FormattingToolbar } from "@/components/blocks/rich-text-editor-1/components/formatting-toolbar";
import { RichTextContent } from "@/components/blocks/rich-text-editor-1/components/rich-text-content";
import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-1/components/rich-text-extensions";
import { RichTextLinkBubble } from "@/components/blocks/rich-text-editor-1/components/rich-text-link";
import { useRichTextSelector } from "@/components/blocks/rich-text-editor-1/components/rich-text-state";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { apiGet, apiSend } from "@/lib/api";
import { logError } from "@/lib/error-log";
import { relativeTime } from "@/lib/format";
import { stripHiddenMarkers, type TiptapDoc } from "@/shared/tiptap-email";
import { diffSummary, diffWords } from "@/shared/text-diff";

import { REVISE_PRESETS, STATUS_LABEL, type DraftSuggestion, type DraftWithHistory } from "./types";
import { useDraftSocket } from "./useDraftSocket";

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  drafting: "default",
  in_gmail: "secondary",
  sent: "outline",
  discarded: "destructive",
};

export interface DraftStudioProps {
  draftId: string;
}

export function DraftStudio({ draftId }: DraftStudioProps) {
  const [draft, setDraft] = React.useState<DraftWithHistory | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState("preview");
  /** Revision shown in Preview/Diff; null means "the latest". */
  const [viewing, setViewing] = React.useState<number | null>(null);
  const [confirmSend, setConfirmSend] = React.useState(false);
  /** A pending Core Guardian suggestion awaiting accept/reject; null when none. */
  const [suggestion, setSuggestion] = React.useState<DraftSuggestion | null>(null);
  const [suggesting, setSuggesting] = React.useState(false);
  const [suggestErr, setSuggestErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setDraft(await apiGet<DraftWithHistory>(`email-drafts/${draftId}`));
    } catch (err) {
      logError({ title: "Could not load the draft", message: (err as Error).message, detail: err, source: "DraftStudio.load" });
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const socket = useDraftSocket(draftId, () => void load());

  const latest = draft?.current ?? null;
  const shown = viewing == null ? latest : (draft?.revisions.find((r) => r.n === viewing) ?? latest);
  const previous = shown ? (draft?.revisions.find((r) => r.n === shown.n - 1) ?? null) : null;
  const openComments = draft?.comments.filter((c) => !c.resolved) ?? [];

  async function act<T>(key: string, run: () => Promise<T>, title: string): Promise<T | undefined> {
    setBusy(key);
    try {
      return await run();
    } catch (err) {
      logError({ title, message: (err as Error).message, detail: err, source: `DraftStudio.${key}` });
      return undefined;
    } finally {
      setBusy(null);
      await load();
    }
  }

  /** Ask the agent (Core Guardian) for a revision. Shows it as a suggestion; writes nothing. */
  async function requestSuggestion(instruction: string) {
    setSuggesting(true);
    setSuggestErr(null);
    try {
      setSuggestion(await apiSend<DraftSuggestion>("POST", `email-drafts/${draftId}/suggest`, { instruction }));
    } catch (err) {
      setSuggestErr((err as Error).message);
      logError({ title: "Could not get a suggestion", message: (err as Error).message, detail: err, source: "DraftStudio.suggest" });
    } finally {
      setSuggesting(false);
    }
  }

  /** Accept the pending suggestion: commit it as a new revision via the normal path. */
  async function acceptSuggestion() {
    if (!suggestion) return;
    const s = suggestion;
    setSuggestion(null);
    await act("revision", () => apiSend("POST", `email-drafts/${draftId}/revisions`, { markdown: s.suggestedMarkdown, note: `Agent revision: ${s.instruction.slice(0, 80)}` }), "Could not apply the suggestion");
    setTab("preview");
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading draft…
      </div>
    );
  }
  if (!draft) {
    return <p className="text-sm text-muted-foreground">That draft does not exist (or was discarded).</p>;
  }

  const readOnly = draft.status === "sent" || draft.status === "discarded";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        <Envelope draft={draft} readOnly={readOnly} onSave={(fields) => act("envelope", () => apiSend("PATCH", `email-drafts/${draftId}`, fields), "Could not update the draft")} />

        {suggestion ? (
          <SuggestionReview
            suggestion={suggestion}
            applying={busy === "revision"}
            onAccept={acceptSuggestion}
            onReject={() => setSuggestion(null)}
          />
        ) : null}

        <Tabs value={tab} onValueChange={setTab}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="preview">Preview</TabsTrigger>
              <TabsTrigger value="edit" disabled={readOnly}>Edit</TabsTrigger>
              <TabsTrigger value="diff" disabled={!previous}>Changes</TabsTrigger>
            </TabsList>
            <span className="text-xs text-muted-foreground">
              {shown ? `Revision ${shown.n} of ${draft.currentRevision}` : "No body yet"}
            </span>
          </div>

          <TabsContent value="preview">
            {shown ? (
              <EmailPaper
                html={shown.html}
                onComment={(quote) =>
                  act("comment", () => apiSend("POST", `email-drafts/${draftId}/comments`, { body: quote.comment, quote: quote.quote, revision: shown.n }), "Could not save the comment")
                }
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No body yet — ask the agent for a first draft.
              </p>
            )}
          </TabsContent>

          <TabsContent value="edit">
            {shown ? (
              <BodyEditor
                key={`${shown.id}`}
                html={shown.html}
                saving={busy === "revision"}
                onSave={(doc, note) =>
                  act("revision", () => apiSend("POST", `email-drafts/${draftId}/revisions`, { doc, note }), "Could not save the revision")
                }
              />
            ) : null}
          </TabsContent>

          <TabsContent value="diff">
            {shown && previous ? <DiffView before={previous.text} after={shown.text} /> : null}
          </TabsContent>
        </Tabs>
      </div>

      <aside className="space-y-6">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Status</h2>
            <LiveDot state={socket} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
            {draft.gmailDraftId ? <Badge variant="outline">in Gmail</Badge> : null}
          </div>
          {!readOnly ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" disabled={!latest || busy !== null} onClick={() => setConfirmSend(true)}>
                <Send className="size-4" /> Send
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!latest || busy !== null}
                onClick={() => act("promote", () => apiSend("POST", `email-drafts/${draftId}/gmail-draft`), "Could not create the Gmail draft")}
              >
                Put in Gmail
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => act("discard", () => apiSend("POST", `email-drafts/${draftId}/discard`), "Could not discard the draft")}
              >
                <Trash2 className="size-4" /> Discard
              </Button>
            </div>
          ) : null}
        </section>

        {!readOnly ? (
          <RevisePanel
            busy={suggesting}
            error={suggestErr}
            hasSuggestion={suggestion !== null}
            onSuggest={requestSuggestion}
          />
        ) : null}

        <RevisionList
          draft={draft}
          viewing={viewing ?? draft.currentRevision}
          onPick={(n) => {
            setViewing(n === draft.currentRevision ? null : n);
            setTab(tab === "edit" ? "preview" : tab);
          }}
        />

        <CommentList
          draft={draft}
          busy={busy === "resolve"}
          onResolve={() => act("resolve", () => apiSend("POST", `email-drafts/${draftId}/comments/resolve`), "Could not resolve the comments")}
        />
      </aside>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this email?</AlertDialogTitle>
            <AlertDialogDescription>
              Revision {latest?.n} goes to {draft.toAddr || "the thread"} now. This cannot be undone, and the draft
              closes to further revisions.
              {openComments.length > 0 ? ` ${openComments.length} comment(s) are still open.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => act("send", () => apiSend("POST", `email-drafts/${draftId}/send`), "Could not send the email")}
            >
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ----------------------------------------------------------------- parts -- */

function LiveDot({ state }: { state: ReturnType<typeof useDraftSocket> }) {
  const tone = state === "live" ? "bg-emerald-500" : state === "connecting" ? "bg-amber-500" : "bg-muted-foreground";
  const label = state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Offline";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`Live updates: ${label.toLowerCase()}`}>
      <span className={`size-2 rounded-full ${tone}`} aria-hidden /> {label}
    </span>
  );
}

function Envelope({
  draft,
  readOnly,
  onSave,
}: {
  draft: DraftWithHistory;
  readOnly: boolean;
  onSave: (fields: Record<string, string>) => void;
}) {
  const [fields, setFields] = React.useState({
    subject: draft.subject ?? "",
    to: draft.toAddr ?? "",
    cc: draft.ccAddr ?? "",
  });
  React.useEffect(() => {
    setFields({ subject: draft.subject ?? "", to: draft.toAddr ?? "", cc: draft.ccAddr ?? "" });
  }, [draft.subject, draft.toAddr, draft.ccAddr]);

  const dirty =
    fields.subject !== (draft.subject ?? "") || fields.to !== (draft.toAddr ?? "") || fields.cc !== (draft.ccAddr ?? "");

  return (
    <section className="grid gap-3 rounded-lg bg-card/40 p-4 ring-1 ring-border/40 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="ds-subject">Subject</Label>
        <Input
          id="ds-subject"
          value={fields.subject}
          disabled={readOnly}
          onChange={(e) => setFields((f) => ({ ...f, subject: e.target.value }))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ds-to">To</Label>
        <Input id="ds-to" value={fields.to} disabled={readOnly} onChange={(e) => setFields((f) => ({ ...f, to: e.target.value }))} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ds-cc">Cc</Label>
        <Input id="ds-cc" value={fields.cc} disabled={readOnly} onChange={(e) => setFields((f) => ({ ...f, cc: e.target.value }))} />
      </div>
      {dirty && !readOnly ? (
        <div className="sm:col-span-2">
          <Button size="sm" variant="secondary" onClick={() => onSave(fields)}>
            <Save className="size-4" /> Save recipients
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The rendered email on white "paper", exactly as the recipient would see it.
 * The HTML is the worker's own sanitized output (scripts, event handlers and
 * `javascript:` urls were stripped before it was ever stored), which is why it
 * can be rendered inline — inline is what makes text selection, and therefore
 * highlight-and-comment, possible at all.
 */
function EmailPaper({ html, onComment }: { html: string; onComment: (c: { quote: string | null; comment: string }) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [quote, setQuote] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");

  // Listening for `selectionchange` rather than wiring mouse/key handlers onto
  // the paper: it also catches keyboard selection and a drag that ends outside
  // the element, and keeps the rendered email a plain non-interactive region.
  React.useEffect(() => {
    const onSelect = () => {
      const sel = window.getSelection();
      const paper = ref.current;
      const text = sel?.toString().trim() ?? "";
      const inside = sel?.anchorNode && paper?.contains(sel.anchorNode);
      setQuote(inside && text && text.length <= 600 ? text : null);
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, []);

  return (
    <div className="space-y-3">
      <div
        ref={ref}
        className="overflow-x-auto rounded-lg bg-white p-6 text-black ring-1 ring-border/40 [&_a]:underline"
        // Worker-sanitized Gmail HTML — the same bytes that would be sent.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div className="space-y-2 rounded-lg bg-card/40 p-3 ring-1 ring-border/40">
        <Label htmlFor="ds-comment" className="text-xs">
          {quote ? "Comment on the highlighted text" : "Comment on this draft"}
        </Label>
        {quote ? <p className="rounded bg-muted/60 px-2 py-1 text-xs italic text-muted-foreground">“{quote}”</p> : null}
        <Textarea
          id="ds-comment"
          rows={2}
          value={comment}
          placeholder="Tell the agent what to change…"
          onChange={(e) => setComment(e.target.value)}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!comment.trim()}
          onClick={() => {
            onComment({ quote, comment: comment.trim() });
            setComment("");
            setQuote(null);
          }}
        >
          <MessageSquarePlus className="size-4" /> Add comment
        </Button>
      </div>
    </div>
  );
}

// Module scope: useEditor compares the extension array by identity each render.
const BODY_EXTENSIONS = createRichTextExtensions({ placeholder: "Write the email…" });
const BODY_EDITOR_PROPS = { attributes: { "aria-label": "Email body", "aria-multiline": "true" } };

/**
 * The Tiptap body editor, built from the ReUI rich-text-editor-1 kit (formatting
 * toolbar + link bubble + editing surface, all as shipped). The editor holds the
 * working copy; "Save as new revision" reads `editor.getJSON()` and appends a
 * numbered revision. The Tiptap doc goes to the Worker, where `tiptapToHtml`
 * reduces it to clean semantic HTML and `gmail/compose.ts` owns the wire format —
 * no editor class or style ever reaches the email body.
 */
function BodyEditor({
  html,
  saving,
  onSave,
}: {
  html: string;
  saving: boolean;
  onSave: (doc: TiptapDoc, note: string) => void;
}) {
  // Read once, when the editor is created (the parent re-keys per revision).
  // The stored HTML is handed to Tiptap as its initial content and parsed in the
  // browser; the hidden ref/authorship markers are dropped first so they never
  // become editable text.
  const initial = React.useMemo(() => stripHiddenMarkers(html), [html]);
  const [note, setNote] = React.useState("");
  const [linkOpen, setLinkOpen] = React.useState(false);

  const editor = useEditor({
    extensions: BODY_EXTENSIONS,
    content: initial,
    editorProps: BODY_EDITOR_PROPS,
    immediatelyRender: false,
  });

  const editable = useRichTextSelector(editor, (current) => current?.isEditable ?? true);

  // Mod-K follows the toolbar: no link where marks are refused (code blocks).
  function openLinkFromKeyboard() {
    setLinkOpen(editable && Boolean(editor?.can().toggleBold()));
  }

  function save() {
    if (!editor) return;
    onSave(editor.getJSON() as TiptapDoc, note.trim() || "Edited on the page");
  }

  return (
    <TooltipProvider delay={300}>
      <div className="space-y-3">
        <div className="overflow-hidden rounded-md bg-input/30 ring-1 ring-border/40 focus-within:ring-2 focus-within:ring-ring/50">
          <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />
          <div className="relative max-h-[32rem] min-h-64 overflow-y-auto">
            <RichTextContent editor={editor} onLinkShortcut={openLinkFromKeyboard} className="px-3 py-2.5" />
            {editor ? <RichTextLinkBubble editor={editor} onEdit={() => setLinkOpen(true)} /> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="ds-note" className="text-xs">What changed (optional)</Label>
            <Input id="ds-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tightened the second paragraph" />
          </div>
          <Button size="sm" disabled={saving} onClick={save}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save as new revision
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Word-level changes from the previous revision. */
function DiffView({ before, after }: { before: string; after: string }) {
  const parts = React.useMemo(() => diffWords(before, after), [before, after]);
  const { added, removed } = diffSummary(parts);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="text-emerald-500">+{added}</span> / <span className="text-rose-500">−{removed}</span> words
        against the previous revision
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-card/40 p-4 text-sm leading-7 ring-1 ring-border/40">
        {parts.map((p, i) => (
          <span
            key={i}
            className={
              p.op === "added"
                ? "rounded bg-emerald-500/15 text-emerald-300"
                : p.op === "removed"
                  ? "rounded bg-rose-500/15 text-rose-300 line-through"
                  : undefined
            }
          >
            {p.value}
          </span>
        ))}
      </pre>
    </div>
  );
}

function RevisionList({
  draft,
  viewing,
  onPick,
}: {
  draft: DraftWithHistory;
  viewing: number;
  onPick: (n: number) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Revisions</h2>
      {draft.revisions.length === 0 ? (
        <p className="text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="space-y-1">
          {[...draft.revisions].reverse().map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPick(r.n)}
                className={`w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/60 ${
                  r.n === viewing ? "bg-muted/70" : ""
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">Revision {r.n}</span>
                  <span className="text-muted-foreground">{r.source === "human" ? "you" : "agent"}</span>
                </span>
                {r.note ? <span className="block text-muted-foreground">{r.note}</span> : null}
                <span className="block text-muted-foreground/70">{relativeTime(r.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentList({ draft, busy, onResolve }: { draft: DraftWithHistory; busy: boolean; onResolve: () => void }) {
  const open = draft.comments.filter((c) => !c.resolved);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Comments</h2>
        {open.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onResolve}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Resolve all
          </Button>
        ) : null}
      </div>
      {draft.comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Highlight a passage in the preview to leave the agent a note.
        </p>
      ) : (
        <ul className="space-y-2">
          {draft.comments.map((c) => (
            <li key={c.id} className={`rounded-md bg-card/40 p-2.5 text-xs ring-1 ring-border/40 ${c.resolved ? "opacity-50" : ""}`}>
              {c.quote ? <p className="mb-1 italic text-muted-foreground">“{c.quote}”</p> : null}
              <p>{c.body}</p>
              <p className="mt-1 text-muted-foreground/70">
                rev {c.revision} · {relativeTime(c.createdAt)}
                {c.resolved ? " · resolved" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The "ask the agent to revise" panel. A free-text instruction plus one-click
 * colby email-strategy presets; the result comes back as a suggestion the human
 * accepts or rejects (never a silent overwrite). The model call runs through
 * Core Guardian on the Worker.
 */
function RevisePanel({
  busy,
  error,
  hasSuggestion,
  onSuggest,
}: {
  busy: boolean;
  error: string | null;
  hasSuggestion: boolean;
  onSuggest: (instruction: string) => void;
}) {
  const [instruction, setInstruction] = React.useState("");
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">Ask the agent</h2>
      <Textarea
        rows={2}
        value={instruction}
        placeholder="e.g. tighten this and strike a firmer tone"
        onChange={(e) => setInstruction(e.target.value)}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-1.5">
        {REVISE_PRESETS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setInstruction(p.instruction);
              onSuggest(p.instruction);
            }}
            title={p.instruction}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <Button size="sm" disabled={busy || !instruction.trim()} onClick={() => onSuggest(instruction.trim())}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Suggest a revision
      </Button>
      {hasSuggestion && !busy ? (
        <p className="text-xs text-muted-foreground">Review the suggestion above, then accept or discard it.</p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">{error}</p>
      ) : null}
    </section>
  );
}

/**
 * The accept/reject card for a pending agent suggestion: a word-level diff of
 * what would change and the rendered preview, with Accept (commit as a new
 * revision) or Discard. The agent never writes the body itself.
 */
function SuggestionReview({
  suggestion,
  applying,
  onAccept,
  onReject,
}: {
  suggestion: DraftSuggestion;
  applying: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <section className="space-y-3 rounded-lg bg-primary/5 p-4 ring-1 ring-primary/30">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" /> Suggested revision
        </h2>
        <span className="text-xs text-muted-foreground">{suggestion.model}</span>
      </div>
      <p className="text-xs italic text-muted-foreground">“{suggestion.instruction}”</p>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">What changes</p>
        <DiffView before={suggestion.originalText} after={suggestion.suggestedText} />
      </div>

      <details className="rounded-md ring-1 ring-border/40">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">Preview the full email</summary>
        <div
          className="overflow-x-auto rounded-b-md bg-white p-6 text-black [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: suggestion.suggestedHtml }}
        />
      </details>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={applying} onClick={onAccept}>
          {applying ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Accept as revision
        </Button>
        <Button size="sm" variant="ghost" disabled={applying} onClick={onReject}>
          <X className="size-4" /> Discard
        </Button>
      </div>
    </section>
  );
}

export default DraftStudio;
