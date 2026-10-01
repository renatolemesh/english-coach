/** Deferred final node: budget, turn log (Postgres), rolling history, and state cleanup. */

import { canonical } from "../../domain/commands.js";
import {
  KEEP_AFTER_SUMMARY,
  MAX_RECENT_TURNS,
  MAX_UNSUMMARIZED_TURNS,
} from "../../domain/conversation.js";
import { HistorySummary } from "../../domain/reply.js";
import { parseLang } from "../../domain/texts.js";
import { getLogger } from "../../logging.js";
import { addUsage, emptyUsage, type Usage } from "../../ports/llm.js";
import type { TurnLog } from "../../ports/repository.js";
import { errorName, levelOf, meta, topicOf } from "../common.js";
import { ctxOf, type GraphContext, type NodeConfig } from "../context.js";
import { type ConversationState, PER_TURN_CLEARED, type Update } from "../state.js";

const log = getLogger("coach.graph.nodes.persist");
const cut = (text: string, n: number) => [...text].slice(0, n).join("");

export async function persist(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const userId = state.user_id;
  const errors = [...(state.errors ?? [])];
  const latencyMs = Math.round(performance.now() - (state.started_at ?? performance.now()));
  const [history, historyUsage] = await updateHistory(state, ctx);
  const usage = (state.usage ?? []).reduce(addUsage, historyUsage);

  try {
    await ctx.limits.record(String(userId), usage);
  } catch (exc) {
    log.exception("budget_record_failed", exc);
  }
  const evaluation = state.evaluation;
  if (evaluation?.mistakes.length) {
    try {
      // personal RAG memory: "you made this mistake before"
      await ctx.retriever.rememberMistakes(userId, topicOf(state), evaluation);
    } catch (exc) {
      log.warning("remember_mistakes_failed", { error: String(exc) });
      errors.push(`rag_memory:${errorName(exc)}`);
    }
  }
  try {
    await ctx.repo.saveTurn(userId, turnLog(state, usage, errors, latencyMs));
  } catch (exc) {
    log.exception("save_turn_failed", exc);
    errors.push(`persist:${errorName(exc)}`);
  }
  log.info("turn_done", {
    kind: state.kind,
    blocked: state.blocked_reason,
    score: evaluation?.score ?? null,
    latency_ms: latencyMs,
    cost_usd: Math.round(usage.costUsd * 1e6) / 1e6,
    tokens: usage.inputTokens + usage.outputTokens,
    sent: state.sent,
    errors,
    notes: state.notes ?? [],
  });
  const kind = state.kind;
  const voiced = (state.sent ?? []).some((s) => s.startsWith("voice:"));
  const extra: Update = {
    text_turns: (state.text_turns ?? 0) + (kind === "text" ? 1 : 0),
    voice_notes: (state.voice_notes ?? 0) + (voiced ? 1 : 0),
    last_seen: Date.now() / 1000,
  };
  if (state.reply_text && kind !== "blocked") extra.last_reply = state.reply_text;
  return {
    ...PER_TURN_CLEARED,
    ...history,
    ...extra,
    turn_count: (state.turn_count ?? 0) + (kind === "audio" || kind === "text" ? 1 : 0),
    usage: null,
    sent: null,
    errors: null,
    notes: null,
  };
}

/** Append this exchange; compact the oldest turns into the summary when too long. */
async function updateHistory(
  state: ConversationState,
  ctx: GraphContext,
): Promise<[Update, Usage]> {
  const reply = state.reply_text;
  const command = `/${state.command ?? ""} ${state.command_arg || ""}`.trim();
  const student = state.text || (state.kind === "command" ? command : "");
  if (!reply || state.kind === "blocked" || state.voice_sample) return [{}, emptyUsage()];
  const turns = [
    ...(state.recent_turns ?? []),
    { student: cut(student, 2000), tutor: cut(reply, 1000) },
  ];
  const summary = state.history_summary || "";
  if (turns.length <= MAX_RECENT_TURNS) return [{ recent_turns: turns }, emptyUsage()];
  const old = turns.slice(0, -KEEP_AFTER_SUMMARY);
  const keep = turns.slice(-KEEP_AFTER_SUMMARY);
  const recent = old.map((t) => `Student: ${t.student}\nTutor: ${t.tutor}`).join("\n");
  const result = await ctx.llm.structured(
    "summarize_history",
    { previous_summary: summary || "(none)", recent_turns: recent },
    HistorySummary,
    { summary, recurring_mistakes: [] },
    meta(state),
  );
  if (result.fallbackUsed) {
    // keep the turns word for word and try again next turn, instead of losing them
    log.warning("summary_failed", { reason: result.fallbackReason });
    return [{ recent_turns: turns.slice(-MAX_UNSUMMARIZED_TURNS) }, result.usage];
  }
  let newSummary = result.value.summary;
  if (result.value.recurring_mistakes.length) {
    newSummary += ` Recurring mistakes: ${result.value.recurring_mistakes.join("; ")}`;
  }
  return [{ recent_turns: keep, history_summary: cut(newSummary, 1200) }, result.usage];
}

/** This turn was "/idioma pt" (or its button): the language is now the student's choice. */
const languageChosen = (s: ConversationState) =>
  s.kind === "command" &&
  canonical(s.command ?? "") === "language" &&
  parseLang(s.command_arg ?? "") !== null;

function turnLog(
  state: ConversationState,
  usage: Usage,
  errors: string[],
  latency: number,
): TurnLog {
  return {
    connection_id: state.connection_id,
    phone: state.phone,
    topic: topicOf(state),
    level: levelOf(state),
    kind: state.kind || "blocked",
    transcript: state.text || null,
    evaluation: state.evaluation ?? null,
    reply_text: state.reply_text ?? null,
    blocked_reason: state.blocked_reason ?? null,
    cost_usd: usage.costUsd,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    latency_ms: latency,
    errors,
    notes: [...(state.notes ?? [])],
    prefs: {
      level: state.level ?? null,
      topic: state.topic ?? null,
      // only a choice (/idioma pt): the default by level must not become a choice
      ui_lang: languageChosen(state) ? (state.ui_lang ?? null) : null,
      tutor: state.tutor ?? null,
      speed: state.speed ?? null,
      daily_goal: state.daily_goal ?? null,
      reminders: state.reminders ?? null,
    },
  };
}
