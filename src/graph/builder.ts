/**
 * The conversation graph:
 *
 *   START → ingest ─┬─ command → route_command → send_text ─┬─ opener → guard_output …
 *                   ├─ audio → transcribe ─┬─ ok → guard_input        └─ else → persist
 *                   ├─ text → guard_input  └─ fail → safe_reply → send_text
 *                   └─ blocked/unsupported → safe_reply
 *   guard_input (rules) ─┬─ blocked → safe_reply
 *                        ├─ Portuguese → portuguese_help → send_text
 *                        └─ ok ─┬→ guard_llm ─┐
 *                               └→ retrieve ──┴→ gate ─┬─ blocked → safe_reply
 *                                                      └─ ok → evaluate
 *   evaluate ─┬→ render_image → send_image ─────────────────────┐
 *             └→ reply → guard_output → synthesize_audio → send_voice → goals ┴→ persist (deferred)
 *
 * The reply runs after evaluate (it gets the correction) in parallel with the image. `persist`
 * is deferred: it runs once, after every branch of the turn finished.
 */
import { type BaseCheckpointSaver, END, START, StateGraph } from "@langchain/langgraph";
import { logLatency } from "../logging.js";
import type { NodeConfig } from "./context.js";
import { evaluate } from "./nodes/evaluate.js";
import { goals } from "./nodes/goals.js";
import {
  gate,
  guardInput,
  guardLlm,
  routeAfterGate,
  routeAfterGuard,
} from "./nodes/guard-input.js";
import { guardOutput } from "./nodes/guard-output.js";
import { ingest, routeAfterIngest } from "./nodes/ingest.js";
import { persist } from "./nodes/persist.js";
import { portugueseHelp } from "./nodes/portuguese-help.js";
import { renderImage } from "./nodes/render-image.js";
import { reply } from "./nodes/reply.js";
import { retrieve } from "./nodes/retrieve.js";
import { routeCommand } from "./nodes/route-command.js";
import { safeReply } from "./nodes/safe-reply.js";
import { routeAfterSendText, sendImage, sendText, sendVoice } from "./nodes/send.js";
import { synthesizeAudio } from "./nodes/synthesize-audio.js";
import { routeAfterTranscribe, transcribe } from "./nodes/transcribe.js";
import { type ConversationState, StateAnnotation, type Update } from "./state.js";

type Node = (state: ConversationState, config: NodeConfig) => Promise<Update>;

export const NODES: Record<string, Node> = {
  ingest,
  route_command: routeCommand,
  transcribe,
  guard_input: guardInput,
  guard_llm: guardLlm,
  gate,
  safe_reply: safeReply,
  portuguese_help: portugueseHelp,
  retrieve,
  evaluate,
  reply,
  guard_output: guardOutput,
  render_image: renderImage,
  synthesize_audio: synthesizeAudio,
  send_text: sendText,
  send_image: sendImage,
  send_voice: sendVoice,
  goals,
  persist,
};

/** Latency per node (user_id/connection_id come from the bound log context). */
const timed = (name: string, node: Node) => (state: ConversationState, config: NodeConfig) =>
  logLatency(name, () => node(state, config));

export function buildGraph(checkpointer?: BaseCheckpointSaver) {
  // biome-ignore lint/suspicious/noExplicitAny: node names are added dynamically from NODES
  const g: any = new StateGraph(StateAnnotation);
  for (const [name, fn] of Object.entries(NODES))
    g.addNode(name, timed(name, fn), { defer: name === "persist" });
  g.addEdge(START, "ingest");
  g.addConditionalEdges("ingest", routeAfterIngest, [
    "route_command",
    "transcribe",
    "guard_input",
    "safe_reply",
  ]);
  g.addConditionalEdges("transcribe", routeAfterTranscribe, ["guard_input", "safe_reply"]);
  g.addConditionalEdges("guard_input", routeAfterGuard, [
    "guard_llm",
    "retrieve",
    "safe_reply",
    "portuguese_help",
  ]);
  g.addEdge(["guard_llm", "retrieve"], "gate"); // waits for both
  g.addConditionalEdges("gate", routeAfterGate, ["evaluate", "safe_reply"]);
  g.addEdge("route_command", "send_text");
  g.addEdge("safe_reply", "send_text");
  g.addEdge("portuguese_help", "send_text");
  g.addConditionalEdges("send_text", routeAfterSendText, [
    "guard_output",
    "synthesize_audio",
    "persist",
  ]);
  g.addEdge("evaluate", "render_image"); // the image and the reply run in parallel
  g.addEdge("evaluate", "reply");
  g.addEdge("render_image", "send_image");
  g.addEdge("reply", "guard_output");
  g.addEdge("guard_output", "synthesize_audio");
  g.addEdge("synthesize_audio", "send_voice");
  g.addEdge("send_image", "persist");
  g.addEdge("send_voice", "goals");
  g.addEdge("goals", "persist");
  g.addEdge("persist", END);
  return g.compile({ checkpointer }) as CompiledConversation;
}

export interface CompiledConversation {
  invoke(input: Update, options: Record<string, unknown>): Promise<ConversationState>;
  updateState(config: Record<string, unknown>, values: Update, asNode?: string): Promise<unknown>;
  getState(config: Record<string, unknown>): Promise<{ values: ConversationState }>;
}
