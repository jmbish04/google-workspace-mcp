/**
 * @fileoverview Wire types for `/api/email-drafts` — the draft studio.
 * Mirrors `src/backend/db/schemas/email-drafts.ts` as it arrives over JSON
 * (timestamps are ISO strings or epoch numbers, never Date).
 */

export type DraftStatus = "drafting" | "in_gmail" | "sent" | "discarded";

export interface DraftRevision {
  id: string;
  draftId: string;
  n: number;
  html: string;
  text: string;
  source: "agent" | "human";
  note: string | null;
  createdAt: string | number;
}

export interface DraftComment {
  id: string;
  draftId: string;
  revision: number;
  quote: string | null;
  body: string;
  resolved: boolean;
  createdAt: string | number;
}

export interface EmailDraftRow {
  id: string;
  account: string | null;
  toAddr: string | null;
  ccAddr: string | null;
  bccAddr: string | null;
  subject: string | null;
  replyToMessageId: string | null;
  threadId: string | null;
  status: DraftStatus;
  currentRevision: number;
  uuid: string | null;
  gmailDraftId: string | null;
  sentMessageId: string | null;
  createdAt: string | number;
  updatedAt: string | number;
}

export interface DraftWithHistory extends EmailDraftRow {
  revisions: DraftRevision[];
  comments: DraftComment[];
  current: DraftRevision | null;
}

/** A Core Guardian revision suggestion (POST /:id/suggest) — nothing is stored yet. */
export interface DraftSuggestion {
  instruction: string;
  originalText: string;
  suggestedMarkdown: string;
  suggestedHtml: string;
  suggestedText: string;
  model: string;
}

/**
 * Colby email-response strategies, surfaced as one-click revise presets. Each
 * fills the instruction sent to the agent. (Full slash-command wiring into the
 * editor lands in a later increment.)
 */
export const REVISE_PRESETS: { key: string; label: string; instruction: string }[] = [
  { key: "yellow-rock-reply", label: "Yellow-rock", instruction: "Rewrite this reply in grey-rock / yellow-rock style: factual, brief, unemotional, giving a high-conflict counterparty nothing to latch onto. Keep only what must be said." },
  { key: "contradiction-ledger", label: "Contradiction ledger", instruction: "Rewrite to calmly lay out, point by point, where the other party's account contradicts the documented record, citing the specifics without editorialising." },
  { key: "regulatory-trap", label: "Regulatory trap", instruction: "Rewrite to put the request on firm regulatory/contractual footing: state the rule or clause that governs, and ask the one question that forces them to commit to a position." },
  { key: "socratic-corner", label: "Socratic corner", instruction: "Rewrite to ask the precise questions that corner the issue, so the recipient must either answer plainly or expose the gap, without accusation." },
  { key: "bad-faith-triage", label: "Bad-faith triage", instruction: "Rewrite to neutrally name the bad-faith move, decline to engage the bait, and restate the single concrete thing you need and by when." },
  { key: "dispute", label: "Dispute", instruction: "Rewrite as a firm, professional dispute of the claim made: what is contested, the basis for contesting it, and the resolution sought." },
];

/** Human-readable status, used on the badge. */
export const STATUS_LABEL: Record<DraftStatus, string> = {
  drafting: "Drafting",
  in_gmail: "In Gmail",
  sent: "Sent",
  discarded: "Discarded",
};
