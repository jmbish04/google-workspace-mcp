CREATE TABLE `scheduled_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_ref` text NOT NULL,
	`account_email` text,
	`spec` text NOT NULL,
	`send_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`message_id` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_emails_due` ON `scheduled_emails` (`status`,`send_at`);