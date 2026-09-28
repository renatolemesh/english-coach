/** The student wrote Portuguese: show how to say it in English instead of grading it. One LLM
 * call (translation) instead of three; the input rules already ran in guard_input. */
import { formatText } from "../../domain/texts.js";
import { textsOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";
import { translate } from "./translate.js";

export async function portugueseHelp(
  state: ConversationState,
  config: NodeConfig,
): Promise<Update> {
  const [english, update] = await translate(
    state,
    ctxOf(config),
    state.text || "",
    "Portuguese",
    "English",
  );
  const t = textsOf(state);
  const template = state.kind === "audio" ? t.portugueseHelpAudio : t.portugueseHelp;
  const text = english ? formatText(template, { english }) : t.portugueseHelpPlain;
  return { ...update, kind: "blocked", blocked_reason: "portuguese", outbound_texts: [text] };
}
