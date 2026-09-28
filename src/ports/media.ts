/** Speech, voice and image ports (heavy adapters live in the worker only). */
import type { Evaluation } from "../domain/evaluation.js";
import type { Transcript } from "../domain/messages.js";

export interface SpeechToText {
  transcribe(audio: Buffer, mime: string): Promise<Transcript>;
}

export interface TextToSpeech {
  /** OGG/Opus bytes ready to send as a WhatsApp voice note. */
  synthesize(text: string, voice: string, speed: number): Promise<Buffer>;
}

export interface ImageRenderer {
  /** The evaluation card as PNG bytes (1080 px wide). */
  render(evaluation: Evaluation, topic?: string | null, level?: string | null): Promise<Buffer>;
}
