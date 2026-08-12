CREATE TABLE `doc_export_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`requested_ref` text NOT NULL,
	`document_id` text NOT NULL,
	`source_account` text,
	`tried_accounts` text,
	`status` text NOT NULL,
	`format` text NOT NULL,
	`tab_scope` text NOT NULL,
	`export_drive_id` text,
	`export_drive_url` text,
	`export_download_url` text,
	`export_sha256` text,
	`source_modified_time` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_doc_export_document` ON `doc_export_jobs` (`document_id`);--> statement-breakpoint
CREATE INDEX `idx_doc_export_request` ON `doc_export_jobs` (`request_id`);