-- Accounts and panel (revision 0008 in alembic_version for databases created before Drizzle).
-- Existing students stay usable: active, on the unlimited plan, phone verified (they already
-- talk to the bot from WhatsApp).
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(60) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"messages_per_day" integer,
	"duration_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_key" UNIQUE("name")
);
--> statement-breakpoint
INSERT INTO "plans" ("name", "description", "messages_per_day", "duration_days") VALUES
	('Teste', 'Teste grátis: 15 mensagens por dia durante 7 dias.', 15, 7),
	('Básico', '50 mensagens por dia.', 50, NULL),
	('Ilimitado', 'Sem limite diário de mensagens.', NULL, NULL);
--> statement-breakpoint
ALTER TABLE "students"
	ADD COLUMN "name" varchar(120),
	ADD COLUMN "status" varchar(16) DEFAULT 'active' NOT NULL,
	ADD COLUMN "plan_id" integer,
	ADD COLUMN "plan_started_at" timestamp with time zone,
	ADD COLUMN "plan_ends_at" timestamp with time zone,
	ADD COLUMN "password_hash" varchar(255),
	ADD COLUMN "verified_at" timestamp with time zone,
	ADD COLUMN "notes" text DEFAULT '' NOT NULL,
	ADD COLUMN "ui_lang" varchar(4),
	ADD COLUMN "tutor" varchar(16),
	ADD COLUMN "speed" double precision,
	ADD COLUMN "last_message_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "students" SET "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Ilimitado'),
	"plan_started_at" = "created_at", "verified_at" = "created_at";
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(200) NOT NULL,
	"name" varchar(120) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" varchar(16) DEFAULT 'staff' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" varchar(200) DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" varchar(200) NOT NULL,
	"action" varchar(64) NOT NULL,
	"target" varchar(200) DEFAULT '' NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(8) NOT NULL,
	"subject_id" integer NOT NULL,
	"csrf" varchar(64) NOT NULL,
	"ip" varchar(64) DEFAULT '' NOT NULL,
	"user_agent" varchar(200) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ix_audit_log_created_at" ON "audit_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "ix_web_sessions_subject" ON "web_sessions" USING btree ("kind","subject_id");
