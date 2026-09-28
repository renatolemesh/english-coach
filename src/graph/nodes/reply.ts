/** Spoken reply that continues the conversation. Runs after `evaluate` (in parallel with the
 * image), so the tutor knows what the student meant and which parts nobody understood. */
import { feedbackForReply } from "../../domain/evaluation.js";
import { Reply, replyFallback } from "../../domain/reply.js";
import { historyOf, levelOf, meta, topicOf, tutorIn } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

export async function reply(state: ConversationState, config: NodeConfig): Promise<Update> {
  const result = await ctxOf(config).llm.structured(
    "conversation_reply",
    {
      topic: topicOf(state),
      level: levelOf(state),
      tutor: tutorIn(state).persona,
      history: historyOf(state),
      transcript: state.text || "",
      correction: feedbackForReply(state.evaluation ?? null),
      retrieved_context: state.retrieved_context || "(none)",
    },
    Reply,
    { text: replyFallback(topicOf(state)) },
    meta(state),
  );
  const update: Update = { reply_text: result.value.text, usage: [result.usage] };
  if (result.fallbackUsed) update.errors = [`reply:${result.fallbackReason}`];
  return update;
}
