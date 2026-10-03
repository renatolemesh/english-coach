CREATE TABLE "app_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"kind" varchar(16) NOT NULL,
	"text" text,
	"data" jsonb,
	"media_id" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_media" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"mime" varchar(80) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_media" ADD CONSTRAINT "app_media_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tokens" ADD CONSTRAINT "app_tokens_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_app_events_student_id" ON "app_events" USING btree ("student_id","id");--> statement-breakpoint
CREATE INDEX "ix_app_media_created_at" ON "app_media" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_app_tokens_student_id" ON "app_tokens" USING btree ("student_id");