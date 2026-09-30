/** Normalized data that crosses boundaries (channel <-> graph). */

import { z } from "zod";
import { formatFixed } from "./format.js";

export const MessageType = z.enum(["text", "audio", "image", "other"]);
export type MessageType = z.infer<typeof MessageType>;

// A Date, an ISO string, or unix time (seconds, or ms above 2e10), as a number or numeric text.
const timestamp = z.union([z.date(), z.number(), z.string()]).pipe(
  z.transform((v, ctx) => {
    let date: Date;
    if (v instanceof Date) date = v;
    else if (typeof v === "number") date = new Date(Math.abs(v) > 2e10 ? v : v * 1000);
    else if (/^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
      const n = Number(v);
      date = new Date(Math.abs(n) > 2e10 ? n : n * 1000);
    } else date = new Date(v);
    if (Number.isNaN(date.getTime())) {
      ctx.issues.push({ code: "custom", message: "invalid datetime", input: v });
      return z.NEVER;
    }
    return date;
  }),
);

/** Provider-agnostic inbound WhatsApp message. */
export const IncomingMessage = z.object({
  id: z.string().describe("Provider message id, used for idempotency."),
  from: z.string().describe("Sender phone number (digits only)."),
  timestamp,
  type: MessageType,
  text: z.string().nullable().default(null),
  media_ref: z.string().nullable().default(null).describe("Opaque ref for download_media."),
  media_size: z.number().int().nullable().default(null).describe("Bytes, when the webhook says."),
  raw: z.record(z.string(), z.unknown()).default(() => ({})),
});
export type IncomingMessage = z.infer<typeof IncomingMessage>;

export class AudioTooLongError extends Error {
  override name = "AudioTooLongError";
  constructor(
    readonly durationS: number,
    readonly maxS: number,
  ) {
    super(`audio has ${formatFixed(durationS, 1)}s, limit is ${maxS}s`);
  }
}

export const Transcript = z.object({
  text: z.string(),
  language: z.string().default("en"),
  avg_logprob: z.number().default(0.0),
  no_speech_prob: z.number().default(0.0),
  duration_s: z.number().default(0.0),
  // words with Whisper's probability (lowest of their tokens): which words came through clearly
  words: z.array(z.object({ text: z.string(), p: z.number() })).default([]),
});
export type Transcript = z.infer<typeof Transcript>;

export function isConfident(t: Transcript, minLogprob: number): boolean {
  return t.avg_logprob >= minLogprob && t.no_speech_prob < 0.6;
}
