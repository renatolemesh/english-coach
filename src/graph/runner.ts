/** Runs one incoming message through the graph for its conversation thread. */
import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import type { RuntimeConfig } from "../accounts/runtime.js";
import { type StudentAccess, uiLangOf } from "../domain/accounts.js";
import type { IncomingMessage } from "../domain/messages.js";
import { withContext } from "../logging.js";
import { buildGraph, type CompiledConversation } from "./builder.js";
import type { GraphContext } from "./context.js";
import { type ConversationState, PER_TURN_CLEARED, type Update } from "./state.js";

export const threadId = (connectionId: string, phone: string) => `${connectionId}:${phone}`;

/** An in-memory saver that can read back its own pending writes. MemorySaver stores a write's
 * bytes without its type and always loads them as JSON, so a raw Buffer write (the image or
 * voice of a failed turn) breaks getState/updateState.
 * Top-level bytes go out as the same JSON record JsonPlusSerializer uses for nested ones. */
export function memorySaver(): MemorySaver {
  const base = new MemorySaver().serde;
  return new MemorySaver({
    async dumpsTyped(data: unknown) {
      if (!(data instanceof Uint8Array)) return base.dumpsTyped(data);
      const record = { lc: 2, type: "constructor", id: ["Uint8Array"], method: "from" };
      const json = JSON.stringify({ ...record, args: [Array.from(data)], kwargs: {} });
      return ["json", new TextEncoder().encode(json)];
    },
    loadsTyped: (type: string, data: Uint8Array | string) => base.loadsTyped(type, data),
  });
}

/** The student's saved preferences (the panel may have changed them) over the thread's
 * values; defaults from the panel for the tutor, and for the language by level (uiLangOf). */
export function preferences(access: StudentAccess, config: RuntimeConfig): Update {
  const values: Update = {
    level: access.level ?? undefined,
    topic: access.topic ?? undefined,
    ui_lang: uiLangOf(access.ui_lang, access.level, config.default_ui_lang),
    tutor: access.tutor || config.default_tutor,
    speed: access.speed ?? undefined,
    daily_goal: access.daily_goal ?? undefined,
  };
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined && v !== null),
  );
}

export class ConversationRunner {
  readonly graph: CompiledConversation;

  /** `prune(threadId)` runs after each turn (keep only the last checkpoint in Postgres). */
  constructor(
    checkpointer: BaseCheckpointSaver = memorySaver(),
    private readonly prune?: (threadId: string) => Promise<void>,
  ) {
    this.graph = buildGraph(checkpointer);
  }

  /** Process one message. Callers must serialize messages of the same thread (the worker
   * holds a Redis lock per thread) so two runs never race on one checkpoint. */
  async handle(
    message: IncomingMessage,
    connectionId: string,
    ctx: GraphContext,
  ): Promise<Partial<ConversationState>> {
    const phone = message.from;
    const admission = await ctx.gate.admit(message, connectionId, ctx.channel, ctx.config);
    if (!admission.access) return {}; // refused or a verification code: already answered
    const access = admission.access;
    if (ctx.course && !admission.start) {
      // lessons (/aula) and their answers; everything else goes on to the conversation
      const course = ctx.course;
      const handled = await withContext(
        { user_id: access.user_id, connection_id: connectionId },
        () => course.handle({ msg: message, access, channel: ctx.channel, config: ctx.config }),
      );
      if (handled) return {};
    }
    const msg = admission.start ? { ...message, type: "text" as const, text: "/start" } : message; // just signed up
    const tid = threadId(connectionId, phone);
    return withContext(
      { user_id: access.user_id, connection_id: connectionId, thread_id: tid },
      async () => {
        const config = { configurable: { thread_id: tid } };
        const input: Update = {
          message: msg,
          connection_id: connectionId,
          phone,
          user_id: access.user_id,
          daily_limit: access.messages_per_day,
          offered_tutors: access.tutors,
          offered_speeds: access.speeds,
          ...preferences(access, ctx.config),
        };
        let state: ConversationState;
        try {
          state = await this.graph.invoke(input, { ...config, context: ctx, durability: "exit" });
        } catch (exc) {
          // LangGraph still checkpoints on failure: drop per-turn objects/buffers so they never
          // reach Postgres, then let the task layer log it.
          await this.graph.updateState(config, PER_TURN_CLEARED, "persist");
          throw exc;
        }
        if (this.prune) {
          try {
            await this.prune(tid);
          } catch {
            // housekeeping must never fail a delivered turn
          }
        }
        return state;
      },
    );
  }

  /** Write topic/level straight into the thread state (simulate, eval). */
  async setProfile(
    connectionId: string,
    phone: string,
    values: { topic?: string; level?: string },
  ) {
    await this.graph.updateState(
      { configurable: { thread_id: threadId(connectionId, phone) } },
      values,
      "persist",
    );
  }
}
