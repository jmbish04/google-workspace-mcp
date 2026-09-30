ALTER TABLE `workspace_subscriptions` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `workspace_subscriptions` ADD `missing_streak` integer DEFAULT 0 NOT NULL;