CREATE TABLE "course_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"lesson_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"item" varchar(160) NOT NULL,
	"type" varchar(16) NOT NULL,
	"correct" boolean NOT NULL,
	"score" integer,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"item" varchar(160) NOT NULL,
	"due" timestamp with time zone NOT NULL,
	"fsrs" jsonb NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_cards_student_item_key" UNIQUE("student_id","item")
);
--> statement-breakpoint
CREATE TABLE "course_lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"kind" varchar(12) NOT NULL,
	"status" varchar(12) NOT NULL,
	"plan" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"current" jsonb,
	"correct" integer DEFAULT 0 NOT NULL,
	"answered" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "lessons_per_day" integer;--> statement-breakpoint
ALTER TABLE "course_attempts" ADD CONSTRAINT "course_attempts_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "public"."course_lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_attempts" ADD CONSTRAINT "course_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_cards" ADD CONSTRAINT "course_cards_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_course_attempts_student" ON "course_attempts" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_course_cards_due" ON "course_cards" USING btree ("student_id","due");--> statement-breakpoint
CREATE INDEX "ix_course_lessons_student" ON "course_lessons" USING btree ("student_id","started_at");--> statement-breakpoint
-- The free plan gets one lesson a day (each lesson is about a dozen WhatsApp messages).
UPDATE "plans" SET "lessons_per_day" = 1 WHERE "name" = 'Grátis';
