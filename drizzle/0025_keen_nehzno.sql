CREATE TABLE `email_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uuid` text NOT NULL,
	`account` text,
	`action` text NOT NULL,
	`subject` text,
	`recipients` text,
	`body` text,
	`thread_id` text,
	`message_id` text,
	`created_by_sub` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_records_uuid_unique` ON `email_records` (`uuid`);