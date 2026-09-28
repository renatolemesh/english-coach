/** RAG context for evaluate/reply (lesson content, grammar notes, past mistakes). */
import { getLogger } from "../../logging.js";
import { buildQuery } from "../../rag/query-builder.js";
import { errorName, levelOf, topicOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.retrieve");

export async function retrieve(state: ConversationState, config: NodeConfig): Promise<Update> {
  const topic = topicOf(state);
  try {
    const context = await ctxOf(config).retriever.retrieve(
      buildQuery(state.text || "", topic),
      topic,
      levelOf(state),
      state.user_id,
    );
    return { retrieved_context: context };
  } catch (exc) {
    log.warning("retrieve_failed", { error: String(exc) }); // an enhancement: never block on it
    return { retrieved_context: "(none)", errors: [`retrieve:${errorName(exc)}`] };
  }
}
