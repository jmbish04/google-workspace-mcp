CREATE TABLE `scheduled_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` text NOT NULL,
	`account_ref` text NOT NULL,
	`account_email` text,
	`cron` text NOT NULL,
	`sent` integer DEFAULT false NOT NULL,
	`sent_message_id` text,
	`last_checked_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_sends_pending` ON `scheduled_sends` (`sent`);