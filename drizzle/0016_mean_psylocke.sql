CREATE TABLE `appsscript_deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`script_id` text NOT NULL,
	`account` text,
	`version_number` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`use_case` text NOT NULL,
	`description` text,
	`files_manifest` text NOT NULL,
	`action` text DEFAULT 'deploy' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_appsscript_script_version` ON `appsscript_deployments` (`script_id`,`version_number`);