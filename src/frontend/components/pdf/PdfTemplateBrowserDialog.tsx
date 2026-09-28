/**
 * @file src/frontend/components/pdf/PdfTemplateBrowserDialog.tsx
 * @description Retrofitted @reui/dialog-5 wide template library dialog for browsing,
 * searching, previewing, and selecting built-in and custom PDF templates.
 */
import React, { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FileText, Search, Sparkles, Code2, PlusCircle, CheckCircle2 } from "lucide-react";

export interface PdfTemplateItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  schemaJson: string;
  sampleDataJson?: string;
  thumbnailUrl?: string;
  isBuiltin: boolean;
  createdAt: string;
}

interface PdfTemplateBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: PdfTemplateItem[];
  onSelectTemplate: (template: PdfTemplateItem) => void;
  onCreateNewScratch?: () => void;
}

const CATEGORIES = [
  { id: "all", label: "All Templates", icon: "📑" },
  { id: "invoice", label: "Invoices & Billing", icon: "🧾" },
  { id: "certificate", label: "Certificates", icon: "🏆" },
  { id: "report", label: "Reports & Briefs", icon: "📊" },
  { id: "receipt", label: "Sales Receipts", icon: "🏷️" },
  { id: "contract", label: "Contracts & Legal", icon: "📜" },
  { id: "shipping", label: "Shipping & Packing", icon: "📦" },
  { id: "ticket", label: "Badges & Passes", icon: "🎟️" },
  { id: "custom", label: "Custom Templates", icon: "✨" },
];

export function PdfTemplateBrowserDialog({
  open,
  onOpenChange,
  templates,
  onSelectTemplate,
  onCreateNewScratch,
}: PdfTemplateBrowserDialogProps) {
  const [activeCategoryId, setActiveCategoryId] = useState("all");
  const [searchValue, setSearchValue] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null);
  const [showRawSchema, setShowRawSchema] = useState(false);

  const filteredTemplates = useMemo(() => {
    return templates.filter((t) => {
      const matchesCategory =
        activeCategoryId === "all" ||
        t.category.toLowerCase() === activeCategoryId.toLowerCase() ||
        (activeCategoryId === "custom" && !t.isBuiltin);

      if (!matchesCategory) return false;
      if (!searchValue.trim()) return true;

      const q = searchValue.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q)) ||
        t.category.toLowerCase().includes(q)
      );
    });
  }, [templates, activeCategoryId, searchValue]);

  const activeTemplate = useMemo(() => {
    return (
      filteredTemplates.find((t) => t.id === selectedId) ||
      filteredTemplates[0] ||
      templates[0] ||
      null
    );
  }, [filteredTemplates, selectedId, templates]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90vh,52rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl lg:max-w-6xl bg-neutral-950 border-neutral-800 text-neutral-100">
        {/* Header */}
        <DialogHeader className="shrink-0 gap-1.5 px-6 pt-5 pb-4 text-left border-b border-neutral-800/80 bg-neutral-900/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <Sparkles className="size-5" />
              </div>
              <div>
                <DialogTitle className="text-lg font-semibold tracking-tight text-neutral-100">
                  PDF Template Studio & Reference Library
                </DialogTitle>
                <DialogDescription className="text-xs text-neutral-400">
                  Select a production blueprint to instantiate, customize with your data, or build from scratch.
                </DialogDescription>
              </div>
            </div>
            {onCreateNewScratch && (
              <Button
                variant="outline"
                size="sm"
                className="border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 gap-1.5 text-xs"
                onClick={() => {
                  onOpenChange(false);
                  onCreateNewScratch();
                }}
              >
                <PlusCircle className="size-3.5" />
                Blank Scratch Template
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Main Body: Category Rail + Card List */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Left Category Rail */}
          <aside className="w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-neutral-800/80 bg-neutral-900/20 p-3 flex flex-col gap-1">
            <p className="px-3 py-1.5 text-[11px] font-medium tracking-wider text-neutral-500 uppercase">
              Template Categories
            </p>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-1 pr-2">
                {CATEGORIES.map((cat) => {
                  const count =
                    cat.id === "all"
                      ? templates.length
                      : cat.id === "custom"
                      ? templates.filter((t) => !t.isBuiltin).length
                      : templates.filter((t) => t.category.toLowerCase() === cat.id).length;
                  const isActive = activeCategoryId === cat.id;

                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveCategoryId(cat.id)}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                        isActive
                          ? "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                          : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 border border-transparent"
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span>{cat.icon}</span>
                        <span>{cat.label}</span>
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-800 text-neutral-400">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </aside>

          {/* Right Content Pane: Search + Cards + Blueprint Drawer */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Search Bar */}
            <div className="p-4 border-b border-neutral-800/80 bg-neutral-900/10 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="size-4 absolute left-3 top-2.5 text-neutral-500" />
                <Input
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  placeholder="Search templates by name, keyword, or schema elements..."
                  className="pl-9 bg-neutral-900/60 border-neutral-700/80 text-xs h-9 text-neutral-200 placeholder:text-neutral-500"
                />
              </div>
              <div className="text-xs text-neutral-400 shrink-0 font-medium">
                {filteredTemplates.length} blueprint{filteredTemplates.length === 1 ? "" : "s"} ready
              </div>
            </div>

            {/* Middle Grid & Details */}
            <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-12 overflow-hidden">
              {/* Cards List */}
              <ScrollArea className="md:col-span-7 border-r border-neutral-800/60 p-4">
                <div className="flex flex-col gap-2.5">
                  {filteredTemplates.length === 0 ? (
                    <div className="text-center py-16 text-neutral-500 text-xs">
                      No templates found matching your criteria.
                    </div>
                  ) : (
                    filteredTemplates.map((t) => {
                      const isSelected = activeTemplate?.id === t.id;
                      return (
                        <div
                          key={t.id}
                          onClick={() => setSelectedId(t.id)}
                          className={`cursor-pointer rounded-xl p-3.5 border transition-all text-left flex items-start gap-3.5 ${
                            isSelected
                              ? "bg-neutral-900 border-sky-500/50 shadow-md ring-1 ring-sky-500/30"
                              : "bg-neutral-900/40 border-neutral-800/70 hover:bg-neutral-900/70 hover:border-neutral-700"
                          }`}
                        >
                          <div className="size-11 rounded-lg bg-neutral-800/80 border border-neutral-700/60 flex items-center justify-center text-sky-400 shrink-0">
                            <FileText className="size-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="text-xs font-semibold text-neutral-100 truncate">
                                {t.name}
                              </h4>
                              {t.isBuiltin ? (
                                <Badge variant="outline" className="text-[10px] border-neutral-700 text-neutral-400 bg-neutral-800/40">
                                  Built-in
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] border-sky-800 text-sky-300 bg-sky-950/40">
                                  Custom
                                </Badge>
                              )}
                            </div>
                            <p className="text-[11px] text-neutral-400 line-clamp-2 mt-1 leading-relaxed">
                              {t.description || "Reusable PDF layout with structured schemas."}
                            </p>
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-[10px] text-neutral-500 capitalize bg-neutral-800/60 px-2 py-0.5 rounded">
                                {t.category}
                              </span>
                              <span className="text-[10px] text-neutral-500">
                                ID: {t.id}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              {/* Right Blueprint / Preview Details */}
              <div className="md:col-span-5 flex flex-col min-h-0 bg-neutral-950/50">
                {activeTemplate ? (
                  <div className="p-5 flex flex-col h-full overflow-hidden">
                    <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
                      <div>
                        <h3 className="text-sm font-semibold text-neutral-100">{activeTemplate.name}</h3>
                        <p className="text-[11px] text-neutral-400 capitalize">{activeTemplate.category} blueprint</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowRawSchema(!showRawSchema)}
                        className="text-neutral-400 hover:text-neutral-100 gap-1 text-[11px] h-7 px-2"
                      >
                        <Code2 className="size-3.5" />
                        {showRawSchema ? "Summary" : "Raw JSON"}
                      </Button>
                    </div>

                    <ScrollArea className="flex-1 my-3 pr-2">
                      {showRawSchema ? (
                        <pre className="text-[10px] font-mono p-3 bg-neutral-900/90 rounded-lg text-neutral-300 border border-neutral-800 whitespace-pre-wrap break-all leading-tight">
                          {activeTemplate.schemaJson}
                        </pre>
                      ) : (
                        <div className="space-y-4 pt-1">
                          <div>
                            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider block mb-1">
                              Description
                            </span>
                            <p className="text-xs text-neutral-300 leading-relaxed bg-neutral-900/50 p-3 rounded-lg border border-neutral-800/60">
                              {activeTemplate.description}
                            </p>
                          </div>

                          <div>
                            <span className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider block mb-1">
                              Sample Data Payload
                            </span>
                            <pre className="text-[10px] font-mono p-3 bg-neutral-900/60 rounded-lg text-emerald-300/90 border border-neutral-800/60 whitespace-pre-wrap max-h-40 overflow-y-auto">
                              {activeTemplate.sampleDataJson || "{}"}
                            </pre>
                          </div>

                          <div className="bg-sky-950/20 border border-sky-900/40 rounded-lg p-3 text-[11px] text-sky-200/90 leading-relaxed">
                            💡 Ready to render directly via REST API (<code className="text-sky-300 font-mono">POST /api/pdf/render</code>) or MCP tool (<code className="text-sky-300 font-mono">pdf_render</code>).
                          </div>
                        </div>
                      )}
                    </ScrollArea>

                    <Button
                      onClick={() => {
                        onSelectTemplate(activeTemplate);
                        onOpenChange(false);
                      }}
                      className="w-full bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs h-9 gap-1.5 shadow-sm mt-auto"
                    >
                      <CheckCircle2 className="size-4" />
                      Instantiate & Generate PDF
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-neutral-500 text-xs p-6 text-center">
                    Select a template to view details and layout blueprint.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 py-3 border-t border-neutral-800/80 bg-neutral-900/40 flex items-center justify-between">
          <div className="text-xs text-neutral-400">
            Powered by <span className="font-semibold text-neutral-300">pdfme</span> · Pure Edge Execution
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 text-xs"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
