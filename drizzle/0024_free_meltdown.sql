CREATE TABLE `drive_tag_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag_id` integer NOT NULL,
	`drive_id` text NOT NULL,
	`drive_type` text,
	`created_by_sub` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_tag_targets_unique` ON `drive_tag_targets` (`tag_id`,`drive_id`);--> statement-breakpoint
CREATE TABLE `drive_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`created_by_sub` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_tags_name_unique` ON `drive_tags` (`name`);