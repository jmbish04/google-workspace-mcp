CREATE TABLE `pdf_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text DEFAULT 'general' NOT NULL,
	`schema_json` text NOT NULL,
	`sample_data_json` text,
	`thumbnail_url` text,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pdf_generation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text,
	`title` text NOT NULL,
	`input_data_json` text NOT NULL,
	`schema_snapshot_json` text,
	`byte_size` integer DEFAULT 0,
	`page_count` integer DEFAULT 1,
	`r2_key` text,
	`r2_share_url` text,
	`drive_file_id` text,
	`drive_url` text,
	`drive_folder_id` text,
	`drive_folder_name` text,
	`drive_account_email` text,
	`drive_sharing_role` text,
	`worker_view_token` text NOT NULL,
	`worker_view_mode` text DEFAULT 'direct-worker' NOT NULL,
	`allow_download` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error_message` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pdf_generation_logs_worker_view_token_unique` ON `pdf_generation_logs` (`worker_view_token`);