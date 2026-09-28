/** Graph test harness: fakes everywhere, in-memory checkpoints. */

import { defaultRuntimeConfig, type RuntimeConfig } from "../../src/accounts/runtime.js";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import type { FakeLLM } from "../../src/adapters/llm/fake.js";
import type { MemoryRepository } from "../../src/adapters/repo/memory.js";
import type { FakeSTT } from "../../src/adapters/stt/fake.js";
import type { FakeTTS } from "../../src/adapters/tts/fake.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { buildContainer, type Container } from "../../src/container.js";
import type { IncomingMessage } from "../../src/domain/messages.js";
import { ConversationRunner, threadId } from "../../src/graph/runner.js";
import type { ConversationState } from "../../src/graph/state.js";

export const CONN = "conn-1";
export const PHONE = "5541999990000";

export function testSettings(over: Partial<Record<keyof Settings, unknown>> = {}): Settings {
  return loadSettings({}, { env: "test", useFakes: true, rateLimitPerMinute: 1000, ...over });
}

export class Harness {
  channel: FakeChannel = new FakeChannel();
  config: RuntimeConfig = { ...defaultRuntimeConfig(), unknown_numbers: "trial" }; // any number may talk

  private constructor(
    readonly container: Container,
    readonly runner: ConversationRunner,
  ) {}

  static async create(
    settings: Settings = testSettings(),
    runner: ConversationRunner = new ConversationRunner(),
  ): Promise<Harness> {
    return new Harness(await buildContainer(settings, { withMedia: true }), runner);
  }

  get llm(): FakeLLM {
    return this.container.llm as FakeLLM;
  }
  get repo(): MemoryRepository {
    return this.container.repo as MemoryRepository;
  }
  get stt(): FakeSTT {
    return this.container.requireMedia().stt as FakeSTT;
  }
  get tts(): FakeTTS {
    return this.container.requireMedia().tts as FakeTTS;
  }

  async send(msg: IncomingMessage): Promise<Partial<ConversationState>> {
    this.channel.sent.length = 0;
    return this.runner.handle(msg, CONN, this.container.graphContext(this.channel, this.config));
  }

  kinds(): string[] {
    return this.channel.sent.map((s) => s.kind);
  }
  texts(): string[] {
    return this.channel.sent.filter((s) => s.kind === "text").map((s) => s.text ?? "");
  }

  /** Pretend the student went away `hours` ago. */
  async age(hours: number): Promise<void> {
    await this.runner.graph.updateState(
      { configurable: { thread_id: threadId(CONN, PHONE) } },
      { last_seen: Date.now() / 1000 - hours * 3600 },
      "persist",
    );
  }
}

let n = 0;
export function textMsg(text: string, id?: number, from = PHONE): IncomingMessage {
  n++;
  return {
    id: `m-${id ?? n}-${n}`,
    from,
    timestamp: new Date(),
    type: "text",
    text,
    media_ref: null,
    media_size: null,
    raw: {},
  };
}

export function audioMsg(ref: string, from = PHONE): IncomingMessage {
  n++;
  return {
    id: `a-${n}`,
    from,
    timestamp: new Date(),
    type: "audio",
    text: null,
    media_ref: ref,
    media_size: 1000,
    raw: {},
  };
}

/** First contact done (welcome + opener). */
export async function started(h: Harness): Promise<void> {
  await h.send(textMsg("hi"));
  h.llm.calls.length = 0;
}
