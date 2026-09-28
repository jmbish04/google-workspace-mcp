CREATE TABLE `workspace_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`folder_id` text NOT NULL,
	`folder_name` text,
	`subscription_name` text,
	`state` text,
	`expire_at` integer,
	`last_error` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_subs_account_folder` ON `workspace_subscriptions` (`account`,`folder_id`);