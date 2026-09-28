/**
 * Input guardrail in two steps.
 * guardInput: deterministic rules (cheap, cannot be talked out of) and the Portuguese check.
 * guardLlm: the cheap LLM classifier, in parallel with `retrieve` (local and cheap); `gate`
 * waits for both before evaluate starts, so the classifier's 1-3 s do not add to every turn.
 */
import { ALLOW_ON_FAILURE, allowed, GuardResult } from "../../domain/guard.js";
import { checkText, looksLikeRequest, looksPortuguese } from "../../guardrails/input-rules.js";
import { getLogger } from "../../logging.js";
import { ACCOUNT_RATE_LIMIT } from "../../ports/llm.js";
import { meta, topicOf } from "../common.js";
import { ctxOf, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";

const log = getLogger("coach.graph.nodes.guard_input");

export async function guardInput(state: ConversationState, config: NodeConfig): Promise<Update> {
  const text = state.text || "";
  const reason = checkText(text, ctxOf(config).settings);
  if (reason) {
    log.info("input_blocked", { reason, by: "rules" });
    return { blocked_reason: reason };
  }
  if (looksPortuguese(text)) {
    log.info("input_portuguese"); // not graded: portuguese_help shows how to say it in English
    return { blocked_reason: "portuguese" };
  }
  return {};
}

/** What the tutor asked last: 'i am software engineer' answers 'What kind of work do you
 * do?' even when the topic is daily routine. */
function lastQuestion(state: ConversationState): string {
  const turns = state.recent_turns ?? [];
  const tutor = turns.at(-1)?.tutor ?? "";
  return turns.length ? [...tutor].slice(-300).join("") : "(none)";
}

export async function guardLlm(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const result = await ctx.llm.structured(
    "guard_input",
    { topic: topicOf(state), last_question: lastQuestion(state), text: state.text || "" },
    GuardResult,
    ALLOW_ON_FAILURE,
    meta(state),
  );
  const update: Update = { usage: [result.usage] };
  if (result.fallbackUsed) {
    update.errors = [`guard:${result.fallbackReason}`];
    if ((result.fallbackReason ?? "").includes(ACCOUNT_RATE_LIMIT)) {
      return { ...update, blocked_reason: "busy" }; // evaluate/reply would fail the same way
    }
  }
  const verdict = result.value;
  if (verdict.verdict === "off_topic" && !looksLikeRequest(state.text || "")) {
    // talking about oneself is practice, even far from the topic
    log.warning("guard_overridden", { verdict: "off_topic", why: verdict.reason });
    return {
      ...update,
      notes: [`guard_overridden:off_topic:${[...verdict.reason].slice(0, 80).join("")}`],
    };
  }
  if (!allowed(verdict)) {
    log.info("input_blocked", { reason: verdict.verdict, by: "llm", why: verdict.reason });
    update.blocked_reason = verdict.verdict;
  }
  return update;
}

/** Join point: runs once guard_llm and retrieve have both finished. */
export async function gate(): Promise<Update> {
  return {};
}

export function routeAfterGuard(state: ConversationState): string | string[] {
  if (state.blocked_reason === "portuguese") return "portuguese_help";
  return state.blocked_reason ? "safe_reply" : ["guard_llm", "retrieve"];
}

/** evaluate runs first: the tutor's reply gets the correction as context. */
export function routeAfterGate(state: ConversationState): string {
  return state.blocked_reason ? "safe_reply" : "evaluate";
}
