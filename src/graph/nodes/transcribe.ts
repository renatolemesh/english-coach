/** Speech-to-text; asks the student to repeat when the audio is unusable. */
import { AudioTooLongError, isConfident } from "../../domain/messages.js";
import { getLogger } from "../../logging.js";
import { errorName } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.transcribe");

export async function transcribe(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const audio = state.audio_in;
  if (!audio) throw new Error("transcribe without audio");
  let transcript: Awaited<ReturnType<typeof ctx.stt.transcribe>>;
  try {
    transcript = await ctx.stt.transcribe(audio, state.audio_mime || "");
  } catch (exc) {
    if (exc instanceof AudioTooLongError) {
      log.info("audio_too_long", { duration_s: exc.durationS });
      return { blocked_reason: "too_long", audio_in: null };
    }
    log.exception("stt_failed", exc);
    return { blocked_reason: "stt_error", audio_in: null, errors: [`stt:${errorName(exc)}`] };
  }
  const note = [`stt:${pyFloat(transcript.avg_logprob)}`];
  if (!transcript.text || !isConfident(transcript, ctx.settings.sttMinConfidence)) {
    log.info("stt_low_confidence", { avg_logprob: transcript.avg_logprob });
    // the text goes along so safe_reply can show what was heard
    return {
      blocked_reason: "low_confidence",
      audio_in: null,
      text: transcript.text,
      stt_confidence: transcript.avg_logprob,
      notes: note,
    };
  }
  return {
    text: transcript.text,
    stt_confidence: transcript.avg_logprob,
    audio_in: null,
    notes: note,
  };
}

/** A float that always shows a decimal point ("-0.5", "-1.0"): the notes keep one format. */
function pyFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

export function routeAfterTranscribe(state: ConversationState): string {
  return state.blocked_reason ? "safe_reply" : "guard_input";
}
