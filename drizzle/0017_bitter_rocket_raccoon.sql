CREATE TABLE `sheet_export_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requested_ref` text NOT NULL,
	`spreadsheet_id` text NOT NULL,
	`source_account` text,
	`tried_accounts` text,
	`status` text NOT NULL,
	`tab_count` integer,
	`json_drive_id` text,
	`json_drive_url` text,
	`json_download_url` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sheet_export_spreadsheet` ON `sheet_export_jobs` (`spreadsheet_id`);