/** Dependencies injected into every node (LangGraph runtime `context`). */
import type { AccountGate } from "../accounts/gate.js";
import type { RuntimeConfig } from "../accounts/runtime.js";
import type { Settings } from "../config.js";
import type { UsageLimits } from "../guardrails/limits.js";
import type { WhatsAppChannel } from "../ports/channel.js";
import type { LLMClient } from "../ports/llm.js";
import type { ImageRenderer, SpeechToText, TextToSpeech } from "../ports/media.js";
import type { TurnRepository } from "../ports/repository.js";
import type { Retriever } from "../ports/retriever.js";
import type { PromptRegistry } from "../prompts/registry.js";

export interface GraphContext {
  settings: Settings;
  llm: LLMClient;
  prompts: PromptRegistry;
  stt: SpeechToText;
  tts: TextToSpeech;
  image: ImageRenderer;
  channel: WhatsAppChannel; // the connection this message arrived on
  repo: TurnRepository;
  retriever: Retriever;
  limits: UsageLimits;
  gate: AccountGate;
  config: RuntimeConfig; // panel settings, per message
}

/** What a node receives as its second argument. */
export interface NodeConfig {
  context?: GraphContext;
}

export function ctxOf(config: NodeConfig): GraphContext {
  if (!config.context) throw new Error("graph run without context");
  return config.context;
}
