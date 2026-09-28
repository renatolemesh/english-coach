/**
 * Translation between the student's language and English (`translate` prompt).
 *
 * Used by the "Traduzir" button (Emma's reply, English -> Portuguese) and when the student writes
 * in Portuguese (how to say it in English).
 */

import { z } from "zod";

// Only these values reach the prompt, outside the delimiter tags (see prompts/CLAUDE.md).
export const Language = z.enum(["English", "Portuguese"]);
export type Language = z.infer<typeof Language>;

export const TRANSLATION_MAX_CHARS = 700;

export const Translation = z
  .object({
    text: z
      .string()
      .max(TRANSLATION_MAX_CHARS)
      .describe("The translation only, natural and faithful, with no notes or quotes."),
  })
  .strict();
export type Translation = z.infer<typeof Translation>;
