/**
 * @fileoverview `gws.accounts` — one row per connected Google mailbox.
 * Replaces D1 `google_accounts` as the target every other gws table points at.
 */
import { integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gws, citext } from "./_base";

export const accountKind = gws.enum("account_kind", ["workspace", "consumer"]);

export const accounts = gws.table(
  "accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    email: citext("email").notNull(),
    kind: accountKind("kind").notNull(),
    /** Name of the credential in the tokens store / Worker secret, never the credential. */
    tokenRef: text("token_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accounts_email_uq").on(t.email)],
);

export type Account = typeof accounts.$inferSelect;
