CREATE TABLE `email_draft_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`revision` integer NOT NULL,
	`quote` text,
	`body` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_draft_comments_draft_idx` ON `email_draft_comments` (`draft_id`,`resolved`);--> statement-breakpoint
CREATE TABLE `email_draft_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`n` integer NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_draft_revisions_draft_n_idx` ON `email_draft_revisions` (`draft_id`,`n`);--> statement-breakpoint
CREATE TABLE `email_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text,
	`to_addr` text,
	`cc_addr` text,
	`bcc_addr` text,
	`subject` text,
	`reply_to_message_id` text,
	`thread_id` text,
	`status` text DEFAULT 'drafting' NOT NULL,
	`current_revision` integer DEFAULT 0 NOT NULL,
	`uuid` text,
	`gmail_draft_id` text,
	`sent_message_id` text,
	`created_by_sub` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_drafts_status_idx` ON `email_drafts` (`status`,`updated_at`);