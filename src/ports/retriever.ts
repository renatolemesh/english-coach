import type { Evaluation } from "../domain/evaluation.js";

export interface Retriever {
  /** Context for prompts (lesson content, grammar notes, the student's past mistakes), already
   * bounded in size. "(none)" when nothing is relevant. */
  retrieve(query: string, topic: string, level: string, userId: number): Promise<string>;
  /** Store this turn's mistakes so later turns can say "you made this mistake before". */
  rememberMistakes(userId: number, topic: string, evaluation: Evaluation): Promise<void>;
}
