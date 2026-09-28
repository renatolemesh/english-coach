/** Normalize the incoming message, apply rate/budget limits, download media. */
import { isFree, lockedPick } from "../../domain/commands.js";
import { MAX_RECENT_TURNS } from "../../domain/conversation.js";
import { looksPortuguese } from "../../guardrails/input-rules.js";
import { getLogger } from "../../logging.js";
import { errorName } from "../common.js";
import { ctxOf, type GraphContext, type NodeConfig } from "../context.js";
import { type ConversationState, PER_TURN_CLEARED, type Update } from "../state.js";

const log = getLogger("coach.graph.nodes.ingest");
const PLAIN_COMMANDS = new Set(["menu"]); // typed without the slash
const RESUME_MAX_WORDS = 3;

const greeting = (text: string) =>
  text.split(/\s+/).filter(Boolean).length <= RESUME_MAX_WORDS || looksPortuguese(text);

function idle(state: ConversationState, hours: number): boolean {
  const last = state.last_seen;
  return Boolean(hours > 0 && last && Date.now() / 1000 - last > hours * 3600);
}

export async function ingest(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const msg = state.message;
  if (!msg) throw new Error("ingest without a message");
  const update: Update = {
    ...PER_TURN_CLEARED,
    message: msg,
    started_at: performance.now(),
    usage: null, // reset reducers
    errors: null,
    sent: null,
    notes: null,
  };
  const text = msg.type === "text" ? (msg.text ?? "").trim() : "";
  const isCommand = text.startsWith("/") || PLAIN_COMMANDS.has(text.toLowerCase());
  const body = isCommand ? text.replace(/^\/+/, "") : "";
  const space = body.indexOf(" ");
  const [name, arg] = space < 0 ? [body, ""] : [body.slice(0, space), body.slice(space + 1)];

  let reason: string | null;
  try {
    // menus and other commands without LLM have a looser limit of their own
    const userId = String(state.user_id);
    const free =
      isFree(name, arg) || lockedPick(name, arg, state.offered_tutors, state.offered_speeds);
    reason =
      isCommand && free
        ? await ctx.limits.checkFree(userId)
        : await ctx.limits.check(
            userId,
            ctx.config.rate_limit_per_minute,
            state.daily_limit,
            ctx.config.timezone,
          );
  } catch (exc) {
    log.warning("limits_check_failed", { error: String(exc) }); // Redis down: fail open, visibly
    reason = null;
    update.errors = [`limits:${errorName(exc)}`];
  }
  if (reason) return { ...update, kind: "blocked", blocked_reason: reason };

  if (!isCommand) Object.assign(update, await restoreHistory(state, ctx));
  const reset = idle(state, ctx.config.session_idle_hours);
  if (reset) {
    log.info("session_idle_reset"); // fresh start, same topic and level
    update.recent_turns = [];
  }
  if (isCommand)
    return { ...update, kind: "command", command: name.toLowerCase(), command_arg: arg.trim() };
  if (state.topic === undefined && update.topic === undefined) {
    return { ...update, kind: "command", command: "start" }; // first contact: welcome + opener
  }
  if (reset && msg.type === "text" && greeting(text)) {
    // "oi, voltei" after days away: welcome back and a new question (a real English answer is
    // graded as usual, with the old context already cleared)
    return { ...update, kind: "command", command: "resume" };
  }
  if (msg.type === "text") return { ...update, kind: "text", text };
  if (msg.type === "audio" && msg.media_ref) {
    if (msg.media_size && msg.media_size > ctx.settings.maxAudioBytes) {
      return { ...update, kind: "blocked", blocked_reason: "too_long" };
    }
    try {
      const [data, mime] = await ctx.channel.downloadMedia(msg.media_ref);
      return { ...update, kind: "audio", audio_in: data, audio_mime: mime };
    } catch (exc) {
      log.warning("media_download_failed", { error: String(exc) });
      return {
        ...update,
        kind: "blocked",
        blocked_reason: "stt_error",
        errors: [`download:${errorName(exc)}`],
      };
    }
  }
  return { ...update, kind: "blocked", blocked_reason: "unsupported" };
}

/**
 * A thread without any memory (a new checkpointer, lost state) for a student who talked to
 * the tutor in this session: rebuild the recent turns from the turns table, so the tutor does
 * not start over. Real case: after the switch to the TS version, "Hello" mid-session got a
 * self-introduction and a question the student had answered an hour before.
 */
async function restoreHistory(state: ConversationState, ctx: GraphContext): Promise<Update> {
  if (state.recent_turns?.length || state.history_summary || state.last_seen) return {};
  const hours = ctx.config.session_idle_hours;
  const since = hours > 0 ? Date.now() / 1000 - hours * 3600 : 0;
  try {
    const past = await ctx.repo.recentTurns(state.user_id, since, MAX_RECENT_TURNS);
    const last = past.at(-1);
    if (!last) return {};
    log.info("history_restored", { turns: past.length });
    return {
      recent_turns: past.map((t) => ({ student: cut(t.student, 2000), tutor: cut(t.tutor, 1000) })),
      last_seen: last.at,
      ...(state.topic === undefined ? { topic: last.topic } : {}),
    };
  } catch (exc) {
    log.warning("history_restore_failed", { error: String(exc) }); // the turn goes on without it
    return {};
  }
}

const cut = (text: string, n: number) => [...text].slice(0, n).join("");

export function routeAfterIngest(state: ConversationState): string {
  const routes: Record<string, string> = {
    command: "route_command",
    audio: "transcribe",
    text: "guard_input",
  };
  return routes[state.kind ?? ""] ?? "safe_reply";
}
