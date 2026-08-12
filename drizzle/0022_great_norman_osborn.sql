CREATE TABLE `email_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text,
	`to_addr` text,
	`html` text NOT NULL,
	`account` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`html` text NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_by_sub` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
