/** Conversation-level models kept in the LangGraph state (checkpointed per thread). */

import { z } from "zod";

export const MAX_RECENT_TURNS = 10; // beyond this, the oldest turns are compacted into the summary
export const KEEP_AFTER_SUMMARY = 6; // kept word for word after a compaction
export const MAX_UNSUMMARIZED_TURNS = 20; // summary keeps failing (free model): drop the oldest

export const TurnRecord = z.object({
  student: z.string().max(2000),
  tutor: z.string().max(1000),
});
export type TurnRecord = z.infer<typeof TurnRecord>;

/** Text for the <history> prompt variable. */
export function renderHistory(summary: string, recent: readonly TurnRecord[]): string {
  const lines = summary ? [`Summary: ${summary}`] : [];
  for (const turn of recent) {
    if (turn.student) lines.push(`Student: ${turn.student}`); // "" = the tutor started
    lines.push(`Tutor: ${turn.tutor}`);
  }
  return lines.join("\n") || "(no history)";
}
