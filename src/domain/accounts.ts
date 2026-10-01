/** What the bot needs to know about a student before a turn (loaded from `students` + `plans`). */

import { z } from "zod";

const optionalDate = z.coerce.date().nullable().default(null);

export const StudentAccess = z.object({
  user_id: z.number().int(),
  status: z.string().default("active"), // active | blocked
  plan_name: z.string().nullable().default(null),
  messages_per_day: z.number().int().nullable().default(null), // null: unlimited
  lessons_per_day: z.number().int().nullable().default(null), // course lessons; null: unlimited
  plan_ends_at: optionalDate,
  tutors: z.array(z.string()).nullable().default(null), // the plan's voices; null: all
  speeds: z.array(z.number()).nullable().default(null), // the plan's speeds; null: all
  name: z.string().nullable().default(null),
  // preferences (null: the conversation keeps its own value or the default)
  level: z.string().nullable().default(null),
  topic: z.string().nullable().default(null),
  ui_lang: z.string().nullable().default(null),
  tutor: z.string().nullable().default(null),
  speed: z.number().nullable().default(null),
  daily_goal: z.number().int().nullable().default(null),
  reminders: z.boolean().default(true), // a nudge before WhatsApp's 24 h window closes
});
export type StudentAccess = z.infer<typeof StudentAccess>;

/** Levels whose fixed messages are in Portuguese unless the student chose a language. */
export const PORTUGUESE_LEVELS: ReadonlySet<string> = new Set(["A1", "A2"]);

/** The language of the fixed messages: the student's choice (/idioma, panel, signup); without
 * one, Portuguese for beginners (instructions in English lose them) and the panel's default
 * from B1 up. */
export function uiLangOf(
  chosen: string | null | undefined,
  level: string | null | undefined,
  fallback: string,
): string {
  if (chosen) return chosen;
  if (level && PORTUGUESE_LEVELS.has(level)) return "pt";
  return fallback;
}

export function expired(access: StudentAccess, now: Date = new Date()): boolean {
  return access.plan_ends_at !== null && access.plan_ends_at.getTime() <= now.getTime();
}

/** Saved after every turn (WhatsApp commands) and by the panel. */
export const Preferences = z.object({
  level: z.string().nullable().default(null),
  topic: z.string().nullable().default(null),
  ui_lang: z.string().nullable().default(null),
  tutor: z.string().nullable().default(null),
  speed: z.number().nullable().default(null),
  daily_goal: z.number().int().nullable().default(null),
  reminders: z.boolean().nullable().default(null),
});
export type Preferences = z.infer<typeof Preferences>;
