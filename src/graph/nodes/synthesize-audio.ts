/** Reply text -> OGG/Opus voice note. */
import { getLogger } from "../../logging.js";
import { errorName, speedIn, tutorIn } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.synthesize_audio");

export async function synthesizeAudio(
  state: ConversationState,
  config: NodeConfig,
): Promise<Update> {
  const ctx = ctxOf(config);
  const text = state.reply_text;
  if (!text) return { voice: null };
  try {
    const ogg = await ctx.tts.synthesize(
      text,
      tutorIn(state).voice,
      speedIn(state, ctx.settings.ttsSpeed),
    );
    return { voice: ogg };
  } catch (exc) {
    log.exception("tts_failed", exc); // send_voice falls back to sending the text
    return { voice: null, errors: [`tts:${errorName(exc)}`] };
  }
}
