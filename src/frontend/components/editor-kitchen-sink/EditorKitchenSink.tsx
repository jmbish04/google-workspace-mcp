"use client";

import {
  FileTextIcon,
  BookOpenIcon,
  FileCheckIcon,
  UsersIcon,
  SparklesIcon,
  MessageSquareIcon,
  LayersIcon,
  RadioIcon,
  ActivityIcon,
} from "lucide-react";
import { useState } from "react";

// ReUI Blocks as shipped
import { RichTextEditor } from "@/components/blocks/rich-text-editor-1/components/rich-text-editor";
import { PageEditor } from "@/components/blocks/rich-text-editor-2/components/page-editor";
import { ContractEditor } from "@/components/blocks/rich-text-editor-3/components/contract-editor";
import { LiveSpecEditor } from "@/components/blocks/rich-text-editor-4/components/live-spec-editor";
import { DocAssistant } from "@/components/blocks/rich-text-editor-5/components/doc-assistant";
import { AskReUISheet } from "@/components/blocks/sheet-10/components/ask-reui-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type EditorTab = "rte-1" | "rte-2" | "rte-3" | "rte-4" | "rte-5" | "sheet-10";

export function EditorKitchenSink() {
  const [activeTab, setActiveTab] = useState<EditorTab>("rte-1");
  const [rte4Mode, setRte4Mode] = useState<"standalone" | "demo">("standalone");

  return (
    <div className="flex w-full flex-col min-h-screen bg-background text-foreground">
      {/* Page Header */}
      <div className="border-b border-border/40 bg-card/40 backdrop-blur-sm px-6 py-6 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <LayersIcon className="size-4" />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                Rich Text Editor Kitchen Sink
              </h1>
              <Badge variant="outline" className="border-border/60 bg-muted/30 text-xs font-mono">
                ReUI Tiptap Pro
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-3xl">
              All five rich-text-editor blocks plus sheet-10 mounted as React islands with real
              document models. Themed via dark/moody design tokens with subtle contrast.
            </p>
          </div>

          {/* Quick Drawer Action: triggers sheet-10 over any editor */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden lg:block text-right mr-2">
              <p className="text-xs font-medium text-foreground">AI Assistant</p>
              <p className="text-[11px] text-muted-foreground font-mono">sheet-10 docked</p>
            </div>
            <AskReUISheet defaultOpen={false} />
          </div>
        </div>
      </div>

      {/* Tabs Container */}
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
        <Tabs
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as EditorTab)}
          className="flex flex-1 flex-col gap-6"
        >
          {/* Tab Selection Bar */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/40 pb-4">
            <TabsList className="h-auto flex-wrap gap-1 bg-muted/40 p-1 rounded-xl ring-1 ring-border/40">
              <TabsTrigger
                value="rte-1"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <FileTextIcon className="size-3.5" />
                <span>RTE 1: Basic</span>
              </TabsTrigger>

              <TabsTrigger
                value="rte-2"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <BookOpenIcon className="size-3.5" />
                <span>RTE 2: Slash & Outline</span>
              </TabsTrigger>

              <TabsTrigger
                value="rte-3"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <FileCheckIcon className="size-3.5" />
                <span>RTE 3: Redline</span>
              </TabsTrigger>

              <TabsTrigger
                value="rte-4"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <UsersIcon className="size-3.5" />
                <span>RTE 4: Collab</span>
              </TabsTrigger>

              <TabsTrigger
                value="rte-5"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <SparklesIcon className="size-3.5" />
                <span>RTE 5: AI Assistant</span>
              </TabsTrigger>

              <TabsTrigger
                value="sheet-10"
                className="gap-2 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium data-[state=active]:bg-card data-[state=active]:shadow-xs"
              >
                <MessageSquareIcon className="size-3.5" />
                <span>Sheet-10: Inset Chat</span>
              </TabsTrigger>
            </TabsList>
          </div>

          {/* ========================================================================= */}
          {/* TAB 1: RTE-1 (Formatting Toolbar, Link Bubble, Task Lists) */}
          {/* ========================================================================= */}
          <TabsContent value="rte-1" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  rich-text-editor-1 · Document Formatter
                </h2>
                <p className="text-xs text-muted-foreground">
                  Formatting toolbar + link bubble + interactive task lists mounted against real
                  launch brief data.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Formatting Toolbar
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Link Bubble
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Task Lists (Checkboxes)
                </Badge>
                <Badge variant="outline" className="text-[11px] font-mono">
                  Word & Char Counts
                </Badge>
              </div>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card shadow-xs overflow-hidden min-h-[720px] flex flex-col">
              <RichTextEditor className="flex-1" />
            </div>
          </TabsContent>

          {/* ========================================================================= */}
          {/* TAB 2: RTE-2 (Slash commands, Mentions, Tables, Outline rail) */}
          {/* ========================================================================= */}
          <TabsContent value="rte-2" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  rich-text-editor-2 · Playbook & Slash Commands
                </h2>
                <p className="text-xs text-muted-foreground">
                  Type <kbd className="rounded bg-muted px-1 font-mono text-[10px]">/</kbd> for
                  blocks, <kbd className="rounded bg-muted px-1 font-mono text-[10px]">@</kbd> for
                  mentions, resizable tables, and right outline rail.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Slash Commands (/)
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  @ Mentions
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Resizable Tables
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Outline Rail
                </Badge>
              </div>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card shadow-xs overflow-hidden min-h-[720px] flex flex-col">
              <PageEditor className="flex-1" />
            </div>
          </TabsContent>

          {/* ========================================================================= */}
          {/* TAB 3: RTE-3 (Redline, Suggesting mode, Sticky review margin) */}
          {/* ========================================================================= */}
          <TabsContent value="rte-3" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  rich-text-editor-3 · Redline & Tracked Changes
                </h2>
                <p className="text-xs text-muted-foreground">
                  Suggesting mode with accept/reject each and all, Final vs Original preview, sticky
                  review margin on desktop.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Suggesting Mode
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Accept / Reject Cards
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Final vs Original Preview
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Sticky Review Margin
                </Badge>
              </div>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card shadow-xs overflow-hidden min-h-[720px] flex flex-col">
              <ContractEditor className="flex-1" />
            </div>
          </TabsContent>

          {/* ========================================================================= */}
          {/* TAB 4: RTE-4 (Collaborative: live cursors, presence, comments, graceful degradation) */}
          {/* ========================================================================= */}
          <TabsContent value="rte-4" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    rich-text-editor-4 · Collaborative Spec
                  </h2>
                  {rte4Mode === "standalone" ? (
                    <Badge
                      variant="outline"
                      className="border-warning/40 text-warning bg-warning/10 text-[10px]"
                    >
                      Graceful Degradation (Offline State)
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-primary/40 text-primary bg-primary/10 text-[10px]"
                    >
                      Simulated Peer Presence Active
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Live cursors, presence stack, offline toggle that queues & merges, comment
                  threads. Phase 3 Yjs persistence provider wire-point recorded.
                </p>
              </div>

              {/* Mode Switcher: Graceful Degradation vs Simulated Live Peers */}
              <div className="flex items-center gap-2 bg-muted/60 p-1 rounded-lg border border-border/40">
                <Button
                  type="button"
                  size="sm"
                  variant={rte4Mode === "standalone" ? "default" : "ghost"}
                  className="h-7 text-xs px-2.5"
                  onClick={() => setRte4Mode("standalone")}
                >
                  <ActivityIcon className="size-3 mr-1" />
                  Standalone (Degraded)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={rte4Mode === "demo" ? "default" : "ghost"}
                  className="h-7 text-xs px-2.5"
                  onClick={() => setRte4Mode("demo")}
                >
                  <RadioIcon className="size-3 mr-1" />
                  Simulated Collaboration
                </Button>
              </div>
            </div>

            {/* Graceful Degradation & Provider Wire-Point Banner */}
            <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground font-semibold">Phase 3 Wire-point:</span>
                <span>
                  TODO Task aaff4cf37733 in{" "}
                  <code className="font-mono text-[11px] text-primary">live-room.ts</code> &amp;{" "}
                  <code className="font-mono text-[11px] text-primary">live-spec-editor.tsx</code>
                </span>
              </div>
              <span className="font-mono text-[11px]">
                {rte4Mode === "standalone"
                  ? "Presence stack shows 0 peers (empty/offline)"
                  : "Peers: Arjun, Maya, Lena active"}
              </span>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card shadow-xs overflow-hidden min-h-[720px] flex flex-col">
              <LiveSpecEditor key={rte4Mode} mode={rte4Mode} className="flex-1" />
            </div>
          </TabsContent>

          {/* ========================================================================= */}
          {/* TAB 5: RTE-5 (AI Assistant: streamed suggestions, step trace, review dock) */}
          {/* ========================================================================= */}
          <TabsContent value="rte-5" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    rich-text-editor-5 · AI Assistant Document
                  </h2>
                  <Badge
                    variant="outline"
                    className="border-primary/40 text-primary bg-primary/10 text-[10px]"
                  >
                    Deterministic Stub Wired
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Streamed suggestions, animated step trace, review dock with accept/reject
                  decisions. Phase 5 Core Guardian wire-point recorded.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Streamed Suggestions
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Step Trace
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Review Dock
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Context Composer
                </Badge>
              </div>
            </div>

            {/* Model Backend Wire-Point Banner */}
            <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-2 text-xs text-muted-foreground flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground font-semibold">Phase 5 Wire-point:</span>
                <span>
                  TODO Task 67656680f6e8 in{" "}
                  <code className="font-mono text-[11px] text-primary">assist-plans.ts</code> (Core
                  Guardian model gateway)
                </span>
              </div>
              <span className="font-mono text-[11px]">
                Actions: Proofread, Tighten, Summarize, Checklist
              </span>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card shadow-xs overflow-hidden min-h-[720px] flex flex-col">
              <DocAssistant className="flex-1" />
            </div>
          </TabsContent>

          {/* ========================================================================= */}
          {/* TAB 6: SHEET-10 (Inset right AI chat sheet with prompt suggestions + pinned composer) */}
          {/* ========================================================================= */}
          <TabsContent value="sheet-10" className="flex flex-1 flex-col gap-4 outline-none">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/60 px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  sheet-10 · Inset Right AI Chat Sheet
                </h2>
                <p className="text-xs text-muted-foreground">
                  Inset right AI chat sheet with prompt suggestion pills, multi-action composer, and
                  message history.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Inset Right Sheet
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Prompt Suggestions
                </Badge>
                <Badge variant="secondary" className="text-[11px] font-mono">
                  Pinned Composer
                </Badge>
                <Badge variant="outline" className="text-[11px] font-mono">
                  Context Tools
                </Badge>
              </div>
            </div>

            <div className="flex-1 rounded-2xl border border-border/40 bg-card/50 shadow-xs p-8 flex flex-col items-center justify-center min-h-[720px]">
              <div className="text-center max-w-md space-y-4">
                <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <SparklesIcon className="size-6" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">Ask ReUI Assistant Sheet</h3>
                <p className="text-xs text-muted-foreground">
                  The sheet is mounted and open as an inset right panel over the workspace. Click
                  below if closed to reopen the drawer with prompt suggestions and pinned composer.
                </p>
                <div className="pt-2">
                  <AskReUISheet defaultOpen={true} />
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
