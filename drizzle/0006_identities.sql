CREATE TABLE "student_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"address" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_identities_connection_address_key" UNIQUE("connection_id","address")
);
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "last_connection_id" varchar(64);--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "last_address" varchar(64);--> statement-breakpoint
ALTER TABLE "student_identities" ADD CONSTRAINT "student_identities_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_student_identities_student_id" ON "student_identities" USING btree ("student_id");--> statement-breakpoint
-- every student so far talked from (connection_id, phone): that is their first identity
INSERT INTO "student_identities" ("student_id", "connection_id", "address") SELECT "id", "connection_id", "phone" FROM "students" ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "students" SET "last_connection_id" = "connection_id", "last_address" = "phone";
