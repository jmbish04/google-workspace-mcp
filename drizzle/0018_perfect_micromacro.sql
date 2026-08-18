ALTER TABLE `sheet_export_jobs` ADD `request_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `sheet_export_jobs` ADD `json_sha256` text;--> statement-breakpoint
ALTER TABLE `sheet_export_jobs` ADD `source_modified_time` text;--> statement-breakpoint
CREATE INDEX `idx_sheet_export_request` ON `sheet_export_jobs` (`request_id`);