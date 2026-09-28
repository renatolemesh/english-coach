/**
 * After an evaluated answer went out: the daily goal (a cheer when this answer reaches it) and
 * the way up (enough good answers at the level moves the student to the next one). Runs after
 * the voice note so the cheer comes last; this turn is not in the turns table yet (persist
 * runs after), so it is added to the counts here.
 */
import { GOOD_SCORE, goalOf, LEVEL_UP, nextLevel } from "../../domain/progress.js";
import { formatText } from "../../domain/texts.js";
import { getLogger } from "../../logging.js";
import { localMidnight } from "../../panel/zones.js";
import { errorName, levelOf, textsOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.goals");

export async function goals(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ev = state.evaluation;
  if (!ev || (state.kind !== "audio" && state.kind !== "text")) return {};
  const ctx = ctxOf(config);
  const t = textsOf(state);
  const level = levelOf(state);
  let stats: { today: number; goodAtLevel: number };
  try {
    const since = localMidnight(ctx.config.timezone);
    stats = await ctx.repo.practiceStats(state.user_id, since, level, GOOD_SCORE);
  } catch (exc) {
    log.warning("practice_stats_failed", { error: String(exc) });
    return { errors: [`goals:${errorName(exc)}`] };
  }
  const update: Update = {};
  const texts: string[] = [];
  const goal = goalOf(state.daily_goal);
  if (stats.today + 1 === goal) texts.push(formatText(t.goalReached, { goal }));
  const next = nextLevel(level);
  const need = LEVEL_UP[level];
  const good = stats.goodAtLevel + (ev.score >= GOOD_SCORE ? 1 : 0);
  if (next && need && good >= need) {
    log.info("level_up", { from: level, to: next });
    update.level = next;
    texts.push(formatText(t.levelUp, { previous: level, level: next, need, cmd: t.cmdLevel }));
  }
  const sent: string[] = [];
  const errors: string[] = [];
  for (const text of texts) {
    try {
      sent.push(`text:${await ctx.channel.sendText(state.phone, text)}`);
    } catch (exc) {
      log.warning("send_failed", { kind: "goal", error: String(exc) });
      errors.push(`send_text:${errorName(exc)}`);
    }
  }
  return { ...update, sent, errors };
}
