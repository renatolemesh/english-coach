/**
 * Reminders: one nudge before WhatsApp's 24 h window closes.
 *
 * Meta delivers free-form messages only within 24 h of the student's last message (outside it,
 * only paid templates), and bills every message. So the rule is strict: a student who last
 * wrote 20-23 h ago, has reminders on and has not met today's goal gets ONE message, around
 * the time they practised the day before. The next one only after they write again (a tap on
 * the reminder's buttons counts, and opens a new window).
 */
import type { RuntimeConfig } from "../accounts/runtime.js";
import { expired, uiLangOf } from "../domain/accounts.js";
import { option } from "../domain/choices.js";
import { GOOD_SCORE, goalOf } from "../domain/progress.js";
import { formatText, textsFor } from "../domain/texts.js";
import { getLogger } from "../logging.js";
import { localMidnight, wallClock } from "../panel/zones.js";
import type { ChatChannel } from "../ports/channel.js";
import type { ReminderCandidate, TurnRepository } from "../ports/repository.js";

const log = getLogger("coach.worker.reminders");
const HOUR_MS = 3600 * 1000;
export const REMIND_AFTER_H = 20; // last message at least this long ago...
export const REMIND_BEFORE_H = 23; // ...and the window (24 h) still open for an hour or more
export const QUIET_FROM_H = 22; // local time: no reminders from 22:00...
export const QUIET_TO_H = 8; // ...to 08:00
export const REMINDERS_EVERY_MS = 10 * 60 * 1000; // the worker's job scheduler

export interface ReminderDeps {
  repo: TurnRepository;
  config: RuntimeConfig;
  channelFor(connectionId: string): Promise<ChatChannel | null>;
  streakOf(userId: number, goal: number, level: string): Promise<number>;
  dueReviews(userId: number, now: Date): Promise<number>;
}

/** Send the reminders due now; the number sent. */
export async function sendReminders(deps: ReminderDeps, now = new Date()): Promise<number> {
  const hour = wallClock(now, deps.config.timezone).hour;
  if (hour >= QUIET_FROM_H || hour < QUIET_TO_H) return 0;
  const candidates = await deps.repo.reminderCandidates(
    new Date(now.getTime() - REMIND_BEFORE_H * HOUR_MS),
    new Date(now.getTime() - REMIND_AFTER_H * HOUR_MS),
  );
  let sent = 0;
  for (const candidate of candidates) {
    try {
      if (await remind(deps, candidate, now)) sent++;
    } catch (exc) {
      log.exception("reminder_failed", exc, { user_id: candidate.access.user_id });
    }
  }
  if (candidates.length) log.info("reminders_done", { candidates: candidates.length, sent });
  return sent;
}

async function remind(deps: ReminderDeps, c: ReminderCandidate, now: Date): Promise<boolean> {
  const { access } = c;
  const userId = access.user_id;
  const tz = deps.config.timezone;
  const level = access.level ?? "B1";
  const goal = goalOf(access.daily_goal);
  // marked first: at most one per window, even when the send below fails
  await deps.repo.markReminded(userId, now);
  if (expired(access, now)) return false;
  const { today } = await deps.repo.practiceStats(
    userId,
    localMidnight(tz, now),
    level,
    GOOD_SCORE,
  );
  if (today >= goal) return false;
  const channel = await deps.channelFor(c.connectionId);
  if (!channel) return false;
  const t = textsFor(uiLangOf(access.ui_lang, access.level, deps.config.default_ui_lang));
  const streak = await deps.streakOf(userId, goal, level);
  const due = streak >= 2 ? 0 : await deps.dueReviews(userId, now);
  const extra =
    streak >= 2
      ? formatText(t.reminderStreak, { n: streak })
      : due > 0
        ? formatText(t.reminderDue, { n: due })
        : "";
  const first = (access.name ?? "").trim().split(/\s+/)[0] ?? "";
  const body = formatText(t.reminder, { name: first ? ` ${first}` : "", done: today, goal, extra });
  const [practice, lesson, stop] = t.reminderButtons;
  await channel.sendChoice(c.phone, {
    body,
    options: [option("resume", practice), option("aula", lesson), option("lembretes:off", stop)],
    button: "",
    fallbackText: `${body}\n\n/aula · /lembretes off`,
  });
  log.info("reminder_sent", { user_id: userId, done: today, goal, streak });
  return true;
}
