/** Output guardrail on the spoken reply: sanitize, then reject non-English or leaking text. */
import { pickOpener } from "../../domain/openers.js";
import { OPENER_FALLBACK, replyFallback } from "../../domain/reply.js";
import {
  dropEchoes,
  dropInventedExperiences,
  ensureQuestion,
  FOLLOW_UP,
  lastQuestion,
  oneQuestion,
  problems,
  repeatsQuestion,
  replaceQuestion,
  sanitize,
  shorten,
} from "../../guardrails/output-rules.js";
import { getLogger } from "../../logging.js";
import { topicOf } from "../common.js";
import { ctxOf, type GraphContext, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.guard_output");
export const OPENER_MAX_CHARS = 200; // topic_opener asks for this; free models overshoot
export const RECENT_QUESTIONS = 3; // tutor turns checked for a repeated question
const cut = (text: string, n: number) => [...text].slice(0, n).join("");

export async function guardOutput(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const raw = state.reply_text || "";
  const opener = state.kind === "command";
  let text = dropInventedExperiences(oneQuestion(sanitize(raw), opener));
  if (!opener) {
    // the tutor never says the student's line back as their own
    text = dropEchoes(text, [state.text || "", state.evaluation?.corrected ?? ""]);
  }
  text = ensureQuestion(text, opener ? null : FOLLOW_UP);
  // openers: short, one question; replies: never the question the tutor just asked
  const checked = text;
  text = opener ? shorten(text, OPENER_MAX_CHARS) : newQuestion(state, ctx, text);
  const notes =
    !opener && text !== checked
      ? [`reply:repeated_question:${cut(lastQuestion(checked), 80)}`]
      : [];
  if (text !== sanitize(raw)) {
    log.warning("reply_trimmed", { before: cut(raw, 300), after: text }); // how often rules break
    notes.push(`reply:trimmed:${cut(raw, 200)}`);
  }
  const found = problems(
    text,
    ctx.prompts.systemTexts(),
    state.retrieved_context || "",
    ctx.prompts.canary,
  );
  if (found.length) {
    log.warning("output_blocked", { reasons: found, preview: cut(raw, 80) });
    const fallback = opener
      ? (pickOpener(ctx.settings.dataDir, topicOf(state), { avoid: state.used_openers ?? [] }) ??
        OPENER_FALLBACK)
      : replyFallback(topicOf(state));
    return {
      reply_text: fallback,
      errors: found.map((r) => `guard_output:${r}`),
      notes: [...notes, `reply:blocked:${cut(raw, 200)}`],
    };
  }
  if (text !== raw)
    log.info("output_sanitized", { before: [...raw].length, after: [...text].length });
  return { reply_text: text, notes };
}

/** The tutor asked this already and the student answered (maybe unclearly, maybe with
 * mistakes): asking again feels like not listening. Swap in a fresh question on the topic from
 * the question bank (no extra LLM call); custom topics have none, so the text stays. */
function newQuestion(state: ConversationState, ctx: GraphContext, text: string): string {
  if (state.evaluation?.mistakes.some((m) => m.type === "unclear")) {
    return text; // part of the answer was lost: asking again (reworded) is right
  }
  const turns = (state.recent_turns ?? []).slice(-RECENT_QUESTIONS);
  const previous = turns.map((t) => lastQuestion(t.tutor ?? "")).filter(Boolean);
  if (!repeatsQuestion(text, previous)) return text;
  const avoid = [...(state.used_openers ?? []), ...previous];
  const idea = pickOpener(ctx.settings.dataDir, topicOf(state), { avoid });
  const question = lastQuestion(idea ?? "");
  log.warning("reply_repeated_question", { question: lastQuestion(text), replacement: question });
  if (!question || repeatsQuestion(question, previous)) return text;
  return replaceQuestion(text, question);
}
