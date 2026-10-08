/**
 * @fileoverview The small summary every Docs read puts first: revision id,
 * page mode and the flattened tab list.
 *
 * A `documents.get` response is large (a 1-page doc with 3 tables is about
 * 100 KB). An agent that only needs to guard a batch (`revisionId`), pick a tab
 * (`tabs`) or know whether page layout applies (`documentMode`) must not have to
 * walk the whole JSON for that. `docs_get_json` and `docs_outline` both lead
 * with {@link summarizeDoc}.
 *
 * Tabs are flattened with {@link flattenTabs}, so a nested child tab id is
 * listed and resolves everywhere else in the engine.
 *
 * @example
 * ```typescript
 * import { summarizeDoc } from "@/backend/docs/doc-summary";
 * const { revisionId, documentMode, tabs } = summarizeDoc(await docs.getRaw(id));
 * ```
 */
import { flattenTabs } from "@/backend/docs/locate";

/** Page mode of a tab: `PAGES`, `PAGELESS`, or null when Google did not say. */
export type DocumentMode = "PAGES" | "PAGELESS" | null;

/** One tab in the flattened tab list. */
export interface TabSummary {
  tabId: string;
  title: string;
  /** Parent tab id for a child tab; null for a top-level tab. */
  parentTabId: string | null;
  /** 0 for a top-level tab, 1 for its child, and so on. */
  nestingLevel: number;
  documentMode: DocumentMode;
}

/** The summary that leads every Docs read result. */
export interface DocSummary {
  documentId: string | null;
  title: string | null;
  /** Pass this as `writeControl.requiredRevisionId` to guard a batch. */
  revisionId: string | null;
  /** Page mode of the first tab (the tab a request without `tabId` targets). */
  documentMode: DocumentMode;
  tabs: TabSummary[];
}

/**
 * Read the page mode a tab's `documentStyle` declares.
 *
 * @param documentStyle - a raw `documentTab.documentStyle` (or legacy root `documentStyle`)
 * @returns `PAGES`, `PAGELESS`, or null when unset or unspecified
 */
export function documentModeOf(documentStyle: any): DocumentMode {
  const mode = documentStyle?.documentFormat?.documentMode;
  return mode === "PAGES" || mode === "PAGELESS" ? mode : null;
}

/**
 * Build the read summary for a raw document.
 *
 * @param raw - `documents.get` JSON, `includeTabsContent=true` shape or the legacy `body` shape
 * @returns revision id, first-tab page mode and the flattened tab list
 * @example
 * summarizeDoc(raw) // → { documentId, title, revisionId: "ALm…", documentMode: "PAGELESS", tabs: [{ tabId: "t.0", … }] }
 */
export function summarizeDoc(raw: any): DocSummary {
  const tabs: TabSummary[] = flattenTabs(raw).map((tab: any) => {
    const props = tab?.tabProperties ?? {};
    return {
      tabId: String(props.tabId ?? ""),
      title: String(props.title ?? ""),
      parentTabId: props.parentTabId ?? null,
      nestingLevel: Number(props.nestingLevel ?? 0),
      documentMode: documentModeOf(tab?.documentTab?.documentStyle),
    };
  });
  return {
    documentId: raw?.documentId ?? null,
    title: raw?.title ?? null,
    revisionId: raw?.revisionId ?? null,
    documentMode: tabs.length ? tabs[0].documentMode : documentModeOf(raw?.documentStyle),
    tabs,
  };
}

/**
 * Resolve a tab id against a raw document: the given id when it exists, else
 * the first tab. Throws for an id the document does not have.
 *
 * @param raw - `documents.get` JSON
 * @param tabId - requested tab id, or undefined for the first tab
 * @returns the resolved tab id, or null for a legacy document with no tabs
 * @throws Error `Tab not found: <id>` when `tabId` is not in the document
 */
export function resolveTabId(raw: any, tabId?: string): string | null {
  const tabs = flattenTabs(raw);
  if (tabId) {
    if (!tabs.some((t: any) => t?.tabProperties?.tabId === tabId)) throw new Error(`Tab not found: ${tabId}`);
    return tabId;
  }
  return tabs[0]?.tabProperties?.tabId ?? null;
}
