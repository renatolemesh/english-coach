ALTER TABLE "plans" ADD COLUMN "tutors" text[];--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "speeds" double precision[];--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "next_plan_id" integer;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "daily_goal" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN "in_ranking" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_next_plan_id_fkey" FOREIGN KEY ("next_plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Free plan: one voice and the two faster speeds; paid plans offer everything (null).
UPDATE "plans" SET "tutors" = ARRAY['sarah'], "speeds" = ARRAY[1.0, 0.9]::double precision[]
WHERE "name" = 'Grátis';
--> statement-breakpoint
-- Signing up gives 30 unlimited days, then the free plan.
INSERT INTO "plans" ("name", "description", "messages_per_day", "duration_days", "next_plan_id")
SELECT 'Teste Ilimitado', '30 dias sem limite; depois vira o plano Grátis.', NULL, 30, "id"
FROM "plans" WHERE "name" = 'Grátis'
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
UPDATE "app_settings" SET "value" = '"Teste Ilimitado"'::jsonb
WHERE "key" = 'trial_plan' AND "value" = '"Grátis"'::jsonb;
