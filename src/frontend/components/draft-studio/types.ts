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

/** Human-readable status, used on the badge. */
export const STATUS_LABEL: Record<DraftStatus, string> = {
  drafting: "Drafting",
  in_gmail: "In Gmail",
  sent: "Sent",
  discarded: "Discarded",
};
