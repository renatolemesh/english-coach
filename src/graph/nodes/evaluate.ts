/** Evaluation JSON, cleaned by the code (the model is not the last word). */
import { cleanEvaluation, Evaluation } from "../../domain/evaluation.js";
import { getLogger } from "../../logging.js";
import { MEMORY_SECTION } from "../../rag/sections.js";
import { historyOf, levelOf, meta, topicOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.evaluate");

// Sentinel: a fallback evaluation is never shown (a fake "0/100" would mislead the student).
const FALLBACK: Evaluation = {
  transcript: "",
  corrected: "",
  score: 0,
  score_breakdown: { grammar: 0, vocabulary: 0, fluency: 0, task: 0 },
  mistakes: [],
  strengths: [],
  tip: "",
};

export async function evaluate(state: ConversationState, config: NodeConfig): Promise<Update> {
  const text = state.text || "";
  const result = await ctxOf(config).llm.structured(
    "evaluate_answer",
    {
      topic: topicOf(state),
      level: levelOf(state),
      transcript: text,
      history: historyOf(state),
      retrieved_context: state.retrieved_context || "(none)",
    },
    Evaluation,
    FALLBACK,
    meta(state),
  );
  if (result.fallbackUsed) {
    return {
      evaluation: null,
      usage: [result.usage],
      errors: [`evaluate:${result.fallbackReason}`],
    };
  }
  // The model is not the source of truth for what the student said.
  const raw = { ...result.value, transcript: text };
  const hasMemory = (state.retrieved_context || "").includes(MEMORY_SECTION);
  const [evaluation, notes] = cleanEvaluation(raw, hasMemory);
  if (notes.length) log.warning("evaluation_cleaned", { notes, prompt_id: "evaluate_answer" });
  return { evaluation, usage: [result.usage], notes: notes.map((n) => `eval:${n}`) };
}
