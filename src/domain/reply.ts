/** Spoken reply text and history summary (outputs of conversation prompts). */

import { z } from "zod";

export const REPLY_MAX_CHARS = 350;
// Pre-defined safe texts (spoken). Used when the model fails or its text is rejected.
// Never "tell me more": the fallback is also what a message nobody could check gets.
export const REPLY_FALLBACK =
  "Sorry, I lost my train of thought there. Let's get back to {topic}. " +
  "What else can you tell me about it?";

export function replyFallback(topic: string): string {
  return REPLY_FALLBACK.replace("{topic}", () => topic);
}

export const OPENER_FALLBACK = "Hi! Let's practice together. So, tell me a little about yourself?";

export const Reply = z
  .object({
    text: z
      .string()
      .max(600) // hard ceiling; guard_output trims to REPLY_MAX_CHARS
      .describe(
        `Spoken English reply, at most ${REPLY_MAX_CHARS} characters, ending with a question. ` +
          "Plain text only: no markdown, lists, emojis, URLs or parentheses.",
      ),
  })
  .strict()
  .describe("Text that goes straight to TTS. Output guardrails sanitize it further (phase 4).");
export type Reply = z.infer<typeof Reply>;

export const HistorySummary = z
  .object({
    summary: z
      .string()
      .max(800)
      .describe("Compact summary of the conversation so far, in English, at most 5 sentences."),
    recurring_mistakes: z
      .array(z.string())
      .max(5)
      .describe(
        "Mistakes the student repeats, each as 'wrong phrase -> right phrase' with enough " +
          "surrounding words to stand alone. At most 5.",
      ),
  })
  .strict();
export type HistorySummary = z.infer<typeof HistorySummary>;
