/** Evaluation card PNG. */
import { getLogger } from "../../logging.js";
import { errorName, levelOf, topicOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.render_image");

export async function renderImage(state: ConversationState, config: NodeConfig): Promise<Update> {
  // a channel that draws the evaluation itself (the app) needs no card: no browser work
  if (!state.evaluation || !ctxOf(config).channel.cards) return { image: null };
  try {
    return {
      image: await ctxOf(config).image.render(state.evaluation, topicOf(state), levelOf(state)),
    };
  } catch (exc) {
    log.exception("render_failed", exc);
    return { image: null, errors: [`image:${errorName(exc)}`] };
  }
}
