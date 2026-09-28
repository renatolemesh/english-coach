-- Free accounts instead of a 7-day trial: signing up gives "Grátis" (15 messages a day, no end).
-- Paid plans with higher limits are added later in the panel.
UPDATE "plans" SET "name" = 'Grátis', "description" = '15 mensagens por dia, sem prazo.', "duration_days" = NULL
WHERE "name" = 'Teste';
--> statement-breakpoint
UPDATE "students" SET "plan_ends_at" = NULL
WHERE "plan_id" = (SELECT "id" FROM "plans" WHERE "name" = 'Grátis');
--> statement-breakpoint
UPDATE "app_settings" SET "value" = '"Grátis"'::jsonb
WHERE "key" = 'trial_plan' AND "value" = '"Teste"'::jsonb;
