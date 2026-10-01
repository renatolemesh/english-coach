/**
 * LangGraph state for one conversation thread (thread_id = connection_id:phone). Keys are
 * snake_case like the stored checkpoints. Checkpointed fields must stay JSON-like; per-turn fields (Buffers,
 * evaluations) are reset by `ingest` and cleared by `persist`, and graphs run with
 * durability "exit", so they never reach Postgres.
 */
import { Annotation } from "@langchain/langgraph";
import type { Choice } from "../domain/choices.js";
import type { Evaluation } from "../domain/evaluation.js";
import type { IncomingMessage } from "../domain/messages.js";
import type { Usage } from "../ports/llm.js";

export type Kind = "audio" | "text" | "command" | "blocked";

/** List reducer for parallel branches; returning null from a node resets the list. */
export function addOrReset<T>(left: T[] | null | undefined, right: T[] | null | undefined): T[] {
  if (right === null || right === undefined) return [];
  return [...(left ?? []), ...right];
}

const list = <T>() => Annotation<T[], T[] | null>({ reducer: addOrReset<T>, default: () => [] });

export const StateAnnotation = Annotation.Root({
  // identity (runner input)
  connection_id: Annotation<string>,
  phone: Annotation<string>,
  user_id: Annotation<number>,
  message: Annotation<IncomingMessage | null>,

  // persistent across turns (checkpointed; primitives only)
  topic: Annotation<string>,
  level: Annotation<string>,
  history_summary: Annotation<string>,
  recent_turns: Annotation<{ student: string; tutor: string }[]>,
  turn_count: Annotation<number>,
  text_turns: Annotation<number>, // typed answers, to nudge towards audio now and then
  last_reply: Annotation<string>, // the tutor's last spoken text (Transcrever/Traduzir buttons)
  voice_notes: Annotation<number>, // voice notes sent; text-only button hints stop after a few
  last_seen: Annotation<number>, // epoch seconds of the last message (idle reset)
  used_openers: Annotation<string[]>, // recent first questions, so a new session asks something new
  tutor: Annotation<string>, // domain/tutors id (survives /reset)
  speed: Annotation<number>, // TTS speed chosen with /velocidade (survives /reset)
  ui_lang: Annotation<string>, // language of the fixed messages (/idioma; survives /reset)
  daily_limit: Annotation<number | null>, // the plan's messages per day (runner input)
  offered_tutors: Annotation<string[] | null>, // the plan's voices, null: all (runner input)
  offered_speeds: Annotation<number[] | null>, // the plan's speeds, null: all (runner input)
  daily_goal: Annotation<number>, // practices a day the student aims for (/meta, panel)
  reminders: Annotation<boolean>, // a nudge before the 24 h window closes (/lembretes, panel)

  // per turn (reset by ingest, cleared by persist)
  kind: Annotation<Kind | null>,
  command: Annotation<string | null>,
  command_arg: Annotation<string>,
  audio_in: Annotation<Buffer | null>,
  audio_mime: Annotation<string>,
  text: Annotation<string>, // what the student said (transcript or typed text)
  stt_confidence: Annotation<number | null>,
  blocked_reason: Annotation<string | null>,
  retrieved_context: Annotation<string>,
  evaluation: Annotation<Evaluation | null>,
  reply_text: Annotation<string | null>,
  voice_sample: Annotation<boolean>, // reply_text samples a new voice/speed: no guard, no history
  image: Annotation<Buffer | null>,
  voice: Annotation<Buffer | null>,
  outbound_texts: Annotation<string[]>,
  outbound_choices: Annotation<Choice[]>, // sent after outbound_texts (menus)
  started_at: Annotation<number>,
  usage: list<Usage>(),
  errors: list<string>(),
  sent: list<string>(),
  notes: list<string>(), // what the code fixed in model output (turns.notes)
});

export type ConversationState = typeof StateAnnotation.State;
export type Update = typeof StateAnnotation.Update;

export const PER_TURN_CLEARED = {
  message: null,
  kind: null,
  command: null,
  command_arg: "",
  audio_in: null,
  audio_mime: "",
  text: "",
  stt_confidence: null,
  blocked_reason: null,
  retrieved_context: "",
  evaluation: null,
  reply_text: null,
  voice_sample: false,
  image: null,
  voice: null,
  outbound_texts: [],
  outbound_choices: [],
} satisfies Update;
