CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_revision_positive" CHECK ("documents"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"author" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"author" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"body" text NOT NULL,
	"thread_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_owner_updated_idx" ON "documents" USING btree ("owner","updated_at");--> statement-breakpoint
CREATE INDEX "suggestions_doc_status_idx" ON "suggestions" USING btree ("doc_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_doc_created_idx" ON "suggestions" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE INDEX "document_comments_doc_resolved_idx" ON "document_comments" USING btree ("doc_id","resolved");--> statement-breakpoint
CREATE INDEX "document_comments_thread_idx" ON "document_comments" USING btree ("thread_id","created_at");