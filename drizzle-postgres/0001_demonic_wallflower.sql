CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "gws";
--> statement-breakpoint
CREATE TYPE "gws"."account_kind" AS ENUM('workspace', 'consumer');--> statement-breakpoint
CREATE TYPE "gws"."participant_role" AS ENUM('from', 'to', 'cc', 'bcc', 'reply_to');--> statement-breakpoint
CREATE TYPE "gws"."attachment_status" AS ENUM('pending', 'staged', 'extracted', 'embedded', 'skipped_junk', 'error');--> statement-breakpoint
CREATE TYPE "gws"."extraction_method" AS ENUM('pdf_text', 'ocr', 'docling', 'office_md', 'plain');--> statement-breakpoint
CREATE TYPE "gws"."job_kind" AS ENUM('index_message', 'stage_attachment', 'extract_attachment', 'embed_message', 'embed_content', 'index_drive_file');--> statement-breakpoint
CREATE TYPE "gws"."job_status" AS ENUM('queued', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "gws"."rule_target" AS ENUM('gmail', 'drive');--> statement-breakpoint
CREATE TYPE "app"."project_status" AS ENUM('active', 'archived', 'on_hold');--> statement-breakpoint
CREATE TYPE "app"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "gws"."accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" "citext" NOT NULL,
	"kind" "gws"."account_kind" NOT NULL,
	"token_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."gmail_threads" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."gmail_threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"subject" text,
	"snippet" text,
	"history_id" text,
	"label_ids" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gmail_message_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"drive_folder_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."gmail_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."gmail_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"thread_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"rfc822_message_id" text,
	"in_reply_to" text,
	"subject" text,
	"snippet" text,
	"internal_date" timestamp with time zone,
	"label_ids" text[] DEFAULT '{}' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_text" text,
	"body_html" text,
	"urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size_bytes" integer,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."message_participants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."message_participants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role" "gws"."participant_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."people" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."people_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" "citext" NOT NULL,
	"display_name" text,
	"first_name" text,
	"last_name" text,
	"organization" text,
	"role_note" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."drive_files" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."drive_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"drive_file_id" text NOT NULL,
	"name" text,
	"mime_type" text,
	"parent_drive_id" text,
	"md5" text,
	"modified_at" timestamp with time zone,
	"content_id" integer,
	"indexed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."file_contents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."file_contents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sha256" text NOT NULL,
	"size_bytes" integer,
	"mime_type" text,
	"extracted_text" text,
	"extraction_method" "gws"."extraction_method",
	"page_count" integer,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."gmail_attachments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."gmail_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" integer NOT NULL,
	"gmail_part_id" text NOT NULL,
	"gmail_attachment_id" text,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"sha256" text,
	"md5" text,
	"is_junk" boolean DEFAULT false NOT NULL,
	"junk_reason" text,
	"content_id" integer,
	"drive_file_id" text,
	"drive_url" text,
	"status" "gws"."attachment_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."content_chunks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."content_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" integer,
	"content_id" integer,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024),
	"tsv" "tsvector",
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_chunks_one_owner" CHECK (("gws"."content_chunks"."message_id" IS NOT NULL AND "gws"."content_chunks"."content_id" IS NULL) OR ("gws"."content_chunks"."message_id" IS NULL AND "gws"."content_chunks"."content_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "gws"."notes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"thread_id" integer NOT NULL,
	"message_id" integer,
	"attachment_id" integer,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_attachment_needs_message" CHECK ("gws"."notes"."attachment_id" IS NULL OR "gws"."notes"."message_id" IS NOT NULL),
	CONSTRAINT "notes_body_not_blank" CHECK (length(btrim("gws"."notes"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "gws"."ingest_jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."ingest_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "gws"."job_kind" NOT NULL,
	"message_id" integer,
	"attachment_id" integer,
	"status" "gws"."job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."ingest_rule_hits" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."ingest_rule_hits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"rule_id" integer NOT NULL,
	"message_id" integer,
	"drive_file_id" integer,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."ingest_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gws"."ingest_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"project_id" integer,
	"target" "gws"."rule_target" NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gws"."sync_cursors" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"history_id" text,
	"last_polled_at" timestamp with time zone,
	"status" text DEFAULT 'idle' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "app"."project_people" (
	"project_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"role_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_people_project_id_person_id_pk" PRIMARY KEY("project_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "app"."project_threads" (
	"project_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_threads_project_id_thread_id_pk" PRIMARY KEY("project_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "app"."projects" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."projects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"background" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "app"."project_status" DEFAULT 'active' NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"owner" text DEFAULT 'you' NOT NULL,
	"starred" integer DEFAULT 0 NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "app"."task_status" DEFAULT 'todo' NOT NULL,
	"priority" text,
	"due_at" timestamp with time zone,
	"source_message_id" integer,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gws"."gmail_threads" ADD CONSTRAINT "gmail_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "gws"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."gmail_messages" ADD CONSTRAINT "gmail_messages_thread_id_gmail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "gws"."gmail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."gmail_messages" ADD CONSTRAINT "gmail_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "gws"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."message_participants" ADD CONSTRAINT "message_participants_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."message_participants" ADD CONSTRAINT "message_participants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "gws"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."drive_files" ADD CONSTRAINT "drive_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "gws"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."drive_files" ADD CONSTRAINT "drive_files_content_id_file_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "gws"."file_contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."gmail_attachments" ADD CONSTRAINT "gmail_attachments_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."gmail_attachments" ADD CONSTRAINT "gmail_attachments_content_id_file_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "gws"."file_contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."content_chunks" ADD CONSTRAINT "content_chunks_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."content_chunks" ADD CONSTRAINT "content_chunks_content_id_file_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "gws"."file_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."notes" ADD CONSTRAINT "notes_thread_id_gmail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "gws"."gmail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."notes" ADD CONSTRAINT "notes_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."notes" ADD CONSTRAINT "notes_attachment_id_gmail_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "gws"."gmail_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_jobs" ADD CONSTRAINT "ingest_jobs_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_jobs" ADD CONSTRAINT "ingest_jobs_attachment_id_gmail_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "gws"."gmail_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_rule_hits" ADD CONSTRAINT "ingest_rule_hits_rule_id_ingest_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "gws"."ingest_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_rule_hits" ADD CONSTRAINT "ingest_rule_hits_message_id_gmail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_rule_hits" ADD CONSTRAINT "ingest_rule_hits_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "gws"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."ingest_rules" ADD CONSTRAINT "ingest_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gws"."sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "gws"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_people" ADD CONSTRAINT "project_people_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_people" ADD CONSTRAINT "project_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "gws"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_threads" ADD CONSTRAINT "project_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_threads" ADD CONSTRAINT "project_threads_thread_id_gmail_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "gws"."gmail_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_source_message_id_gmail_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "gws"."gmail_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_uq" ON "gws"."accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_threads_account_gmail_uq" ON "gws"."gmail_threads" USING btree ("account_id","gmail_thread_id");--> statement-breakpoint
CREATE INDEX "gmail_threads_last_message_idx" ON "gws"."gmail_threads" USING btree ("account_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_messages_account_gmail_uq" ON "gws"."gmail_messages" USING btree ("account_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "gmail_messages_thread_date_idx" ON "gws"."gmail_messages" USING btree ("thread_id","internal_date");--> statement-breakpoint
CREATE UNIQUE INDEX "message_participants_uq" ON "gws"."message_participants" USING btree ("message_id","person_id","role");--> statement-breakpoint
CREATE INDEX "message_participants_person_idx" ON "gws"."message_participants" USING btree ("person_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "people_email_uq" ON "gws"."people" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_account_drive_uq" ON "gws"."drive_files" USING btree ("account_id","drive_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_contents_sha256_uq" ON "gws"."file_contents" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_attachments_message_part_uq" ON "gws"."gmail_attachments" USING btree ("message_id","gmail_part_id");--> statement-breakpoint
CREATE INDEX "gmail_attachments_sha_idx" ON "gws"."gmail_attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "gmail_attachments_status_idx" ON "gws"."gmail_attachments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_chunks_embedding_hnsw" ON "gws"."content_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "content_chunks_tsv_gin" ON "gws"."content_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "content_chunks_message_idx" ON "gws"."content_chunks" USING btree ("message_id","chunk_index");--> statement-breakpoint
CREATE INDEX "content_chunks_content_idx" ON "gws"."content_chunks" USING btree ("content_id","chunk_index");--> statement-breakpoint
CREATE INDEX "notes_thread_idx" ON "gws"."notes" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_message_idx" ON "gws"."notes" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "notes_attachment_idx" ON "gws"."notes" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "ingest_jobs_claim_idx" ON "gws"."ingest_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "ingest_rule_hits_rule_idx" ON "gws"."ingest_rule_hits" USING btree ("rule_id","matched_at");--> statement-breakpoint
CREATE INDEX "ingest_rules_target_priority_idx" ON "gws"."ingest_rules" USING btree ("target","enabled","priority");--> statement-breakpoint
CREATE INDEX "project_people_person_idx" ON "app"."project_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "project_threads_thread_idx" ON "app"."project_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_key_uq" ON "app"."projects" USING btree ("key");--> statement-breakpoint
CREATE INDEX "tasks_project_status_idx" ON "app"."tasks" USING btree ("project_id","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION gws.content_chunks_tsv() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.tsv := to_tsvector('english', coalesce(NEW.text, ''));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_chunks_tsv_trg BEFORE INSERT OR UPDATE OF text ON gws.content_chunks
  FOR EACH ROW EXECUTE FUNCTION gws.content_chunks_tsv();
