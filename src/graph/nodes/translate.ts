/** Shared translation call ("Traduzir" button and Portuguese-message help). */
import { Language, TRANSLATION_MAX_CHARS, Translation } from "../../domain/translation.js";
import { leaks } from "../../guardrails/output-rules.js";
import { getLogger } from "../../logging.js";
import { meta } from "../common.js";
import type { GraphContext } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.translate");

/** [translation or null, state update with usage/errors]. */
export async function translate(
  state: ConversationState,
  ctx: GraphContext,
  text: string,
  source: Language,
  target: Language,
): Promise<[string | null, Update]> {
  // These go outside the delimiter tags: code constants only, never user input.
  Language.parse(source);
  Language.parse(target);
  const result = await ctx.llm.structured(
    "translate",
    { source_language: source, target_language: target, text },
    Translation,
    { text: "" },
    meta(state),
  );
  const update: Update = { usage: [result.usage] };
  const out = [...result.value.text.trim()].slice(0, TRANSLATION_MAX_CHARS).join("");
  if (result.fallbackUsed)
    return [null, { ...update, errors: [`translate:${result.fallbackReason}`] }];
  const canary = ctx.prompts.canary;
  if (
    !out ||
    (canary && out.toLowerCase().includes(canary.toLowerCase())) ||
    leaks(out, ctx.prompts.systemTexts(), 8)
  ) {
    log.warning("translation_rejected", { preview: [...out].slice(0, 80).join("") });
    return [null, { ...update, errors: ["translate:rejected"] }];
  }
  return [out, update];
}
