/** Delivery nodes. Split so the image goes out as soon as it is ready (TTS takes ~10 s). */
import { voiceHelp } from "../../domain/choices.js";
import { getLogger } from "../../logging.js";
import { errorName, textsOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.send");
export const TEXT_HINT_VOICE_NOTES = 3; // channels without buttons get the text hint this often

export async function sendText(state: ConversationState, config: NodeConfig): Promise<Update> {
  const { channel } = ctxOf(config);
  const sent: string[] = [];
  const errors: string[] = [];
  for (const text of state.outbound_texts ?? []) {
    try {
      sent.push(`text:${await channel.sendText(state.phone, text)}`);
    } catch (exc) {
      log.exception("send_failed", exc, { kind: "text" });
      errors.push(`send_text:${errorName(exc)}`);
    }
  }
  for (const choice of state.outbound_choices ?? []) {
    try {
      sent.push(`choice:${await channel.sendChoice(state.phone, choice)}`);
    } catch (exc) {
      log.warning("send_failed", { kind: "choice", error: String(exc) });
      errors.push(`send_choice:${errorName(exc)}`);
    }
  }
  return { sent, errors };
}

export async function sendImage(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const t = textsOf(state);
  try {
    const { channel } = ctx;
    const structured = !channel.cards && channel.sendEvaluation;
    if (state.evaluation && (state.image || structured)) {
      let caption = `Score: ${state.evaluation.score}/100`;
      const confidence = state.stt_confidence;
      if (
        state.kind === "audio" &&
        confidence !== null &&
        confidence !== undefined &&
        confidence < ctx.settings.sttSureConfidence
      ) {
        caption += `\n\n${t.heardUnsure.replace("{heard}", state.text || "")}`;
      } else if (state.kind === "text" && (state.text_turns ?? 0) % 3 === 0) {
        caption += `\n\n${t.audioNudge}`; // 1st, 4th, 7th... typed answer
      }
      const id =
        structured && channel.sendEvaluation
          ? `evaluation:${await channel.sendEvaluation(state.phone, state.evaluation, caption)}`
          : `image:${await channel.sendImage(state.phone, state.image as Buffer, caption)}`;
      return { sent: [id] };
    }
    return { sent: [`text:${await ctx.channel.sendText(state.phone, t.evaluationUnavailable)}`] };
  } catch (exc) {
    log.exception("send_failed", exc, { kind: "image" });
    return { errors: [`send_image:${errorName(exc)}`] };
  }
}

export async function sendVoice(state: ConversationState, config: NodeConfig): Promise<Update> {
  const { channel } = ctxOf(config);
  const sent: string[] = [];
  try {
    if (state.voice) sent.push(`voice:${await channel.sendVoice(state.phone, state.voice)}`);
    else if (state.reply_text) {
      // TTS failed: the conversation still continues
      return { sent: [`text:${await channel.sendText(state.phone, state.reply_text)}`] };
    } else return {};
  } catch (exc) {
    log.exception("send_failed", exc, { kind: "voice" });
    return { errors: [`send_voice:${errorName(exc)}`] };
  }
  if (state.voice_sample) return { sent }; // just a sample of the new voice or speed
  if (!channel.interactive && (state.voice_notes ?? 0) >= TEXT_HINT_VOICE_NOTES) return { sent };
  try {
    // Transcrever / Traduzir / Menu under the voice note; losing it is not worth failing
    sent.push(`choice:${await channel.sendChoice(state.phone, voiceHelp(textsOf(state)))}`);
  } catch (exc) {
    log.warning("send_failed", { kind: "choice", error: String(exc) });
    return { sent, errors: [`send_choice:${errorName(exc)}`] };
  }
  return { sent };
}

/** Commands like /tema also produce a spoken opener; /voz and /velocidade replay the last
 * reply (already checked by guard_output when it was first said) in the new voice. */
export function routeAfterSendText(state: ConversationState): string {
  if (!state.reply_text) return "persist";
  return state.voice_sample ? "synthesize_audio" : "guard_output";
}
