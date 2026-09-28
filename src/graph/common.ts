/** Helpers shared by nodes. */
import { renderHistory } from "../domain/conversation.js";
import { type Texts, textsFor } from "../domain/texts.js";
import { DEFAULT_LEVEL, DEFAULT_TOPIC } from "../domain/topics.js";
import { effectiveSpeed, effectiveTutor, type Tutor } from "../domain/tutors.js";
import type { ConversationState } from "./state.js";

export const topicOf = (s: ConversationState): string => s.topic || DEFAULT_TOPIC;
export const levelOf = (s: ConversationState): string => s.level || DEFAULT_LEVEL;
/** The tutor and speed that play: the student's choice, within what the plan offers. */
export const tutorIn = (s: ConversationState): Tutor => effectiveTutor(s.tutor, s.offered_tutors);
export const speedIn = (s: ConversationState, fallback: number): number =>
  effectiveSpeed(s.speed || fallback, s.offered_speeds);
export const textsOf = (s: ConversationState): Texts => textsFor(s.ui_lang);

export function historyOf(s: ConversationState): string {
  return renderHistory(s.history_summary || "", s.recent_turns ?? []);
}

/** Log metadata for LLM calls (never sent to the model). */
export function meta(s: ConversationState): Record<string, unknown> {
  return {
    user_id: s.user_id,
    connection_id: s.connection_id,
    thread_id: `${s.connection_id}:${s.phone}`,
  };
}

export const errorName = (exc: unknown): string =>
  exc instanceof Error ? exc.constructor.name : "Error";
