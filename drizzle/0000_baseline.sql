-- The schema of existing databases created before Drizzle (revision 0007 in alembic_version).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"enabled" boolean NOT NULL,
	"credentials" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"collection" varchar(32) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"key" varchar(120),
	"source" varchar(200),
	"content" text NOT NULL,
	"topic" varchar(120),
	"level" varchar(8),
	"kind" varchar(32) NOT NULL,
	"user_id" integer,
	"metadata" jsonb NOT NULL,
	"embedding" vector(384) NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_content_hash_key" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "mistakes" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"turn_id" integer NOT NULL,
	"original" text NOT NULL,
	"correction" text NOT NULL,
	"type" varchar(16) NOT NULL,
	"explanation" text NOT NULL,
	"topic" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"topic" varchar(120),
	"level" varchar(8) DEFAULT 'B1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "students_connection_id_phone_key" UNIQUE("connection_id","phone")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"topic" varchar(120) NOT NULL,
	"level" varchar(8) NOT NULL,
	"transcript" text,
	"evaluation" jsonb,
	"score" integer,
	"reply_text" text,
	"blocked_reason" varchar(32),
	"cost_usd" double precision NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" double precision NOT NULL,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" jsonb
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"message_id" varchar(128),
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'received' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mistakes" ADD CONSTRAINT "mistakes_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mistakes" ADD CONSTRAINT "mistakes_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ix_documents_embedding_hnsw" ON "documents" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX "ix_documents_filters" ON "documents" USING btree ("collection","topic","level");
--> statement-breakpoint
CREATE INDEX "ix_documents_tsv" ON "documents" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "ix_documents_user" ON "documents" USING btree ("user_id") WHERE (user_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "ix_mistakes_student_id" ON "mistakes" USING btree ("student_id");
--> statement-breakpoint
CREATE INDEX "ix_students_connection_id" ON "students" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "ix_turns_student_id" ON "turns" USING btree ("student_id");
--> statement-breakpoint
CREATE INDEX "ix_webhook_events_connection_id" ON "webhook_events" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "ix_webhook_events_message_id" ON "webhook_events" USING btree ("message_id");
