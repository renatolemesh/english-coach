/** Scripted LLMClient for tests and simulate: canned answers per prompt, records every call.
 * With a registry, variables are checked by rendering (same errors as the real client). */
import type { z } from "zod";
import { emptyUsage, type LLMClient, type LLMResult } from "../../ports/llm.js";
import type { PromptRegistry } from "../../prompts/registry.js";

export type Responder =
  | Record<string, unknown>
  | ((vars: Record<string, string>) => Record<string, unknown>);

export function defaultResponses(): Record<string, Responder> {
  return {
    guard_input: { verdict: "allow", reason: "fake" },
    evaluate_answer: (v) => ({
      transcript: v.transcript,
      corrected: v.transcript,
      score: 80,
      score_breakdown: { grammar: 80, vocabulary: 80, fluency: 80, task: 80 },
      mistakes: [],
      strengths: ["Clear answer."],
      tip: "Keep practicing full sentences.",
    }),
    conversation_reply: { text: "Oh nice! Tell me more. What happened next?" },
    topic_opener: { text: "Hi! Let's talk. What's the first thing you'd say?" },
    translate: (v) => ({ text: `[${v.target_language}] ${v.text}` }),
    summarize_history: { summary: "The student is practicing.", recurring_mistakes: [] },
  };
}

export class FakeLLM implements LLMClient {
  readonly responses: Record<string, Responder>;
  readonly calls: [string, Record<string, string>][] = [];

  constructor(
    private readonly registry?: PromptRegistry,
    responses: Record<string, Responder> = {},
  ) {
    this.responses = { ...defaultResponses(), ...responses };
  }

  async structured<S extends z.ZodType>(
    promptId: string,
    variables: Record<string, string>,
    outputModel: S,
    fallback: z.infer<S>,
  ): Promise<LLMResult<z.infer<S>>> {
    this.registry?.render(promptId, variables);
    this.calls.push([promptId, variables]);
    const responder = this.responses[promptId];
    if (responder === undefined) {
      return {
        value: fallback,
        usage: emptyUsage(),
        fallbackUsed: true,
        fallbackReason: "fake:no_response",
      };
    }
    const data = typeof responder === "function" ? responder(variables) : responder;
    return {
      value: outputModel.parse(data),
      usage: emptyUsage("fake"),
      fallbackUsed: false,
      fallbackReason: null,
    };
  }
}
