/** A course engine on the small fixture content, with fakes everywhere. */
import path from "node:path";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { MemoryCourseRepository } from "../../src/adapters/course/memory.js";
import { FakeSTT } from "../../src/adapters/stt/fake.js";
import { FakeTTS } from "../../src/adapters/tts/fake.js";
import { PROJECT_ROOT } from "../../src/config.js";
import { CourseContent } from "../../src/course/content.js";
import { CourseEngine } from "../../src/course/engine.js";
import type { Exercise } from "../../src/course/exercises.js";
import { StudentAccess } from "../../src/domain/accounts.js";
import type { IncomingMessage } from "../../src/domain/messages.js";
import { UsageLimits } from "../../src/guardrails/limits.js";
import { testSettings } from "../graph/harness.js";

export const content = () => CourseContent.load(path.join(PROJECT_ROOT, "test/fixtures/course"));

/** Deterministic Math.random replacement (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let n = 0;
export function message(text: string | null, audio?: string): IncomingMessage {
  n++;
  return {
    id: `c-${n}`,
    from: "5511987654321",
    timestamp: new Date(),
    type: audio !== undefined ? "audio" : "text",
    text,
    media_ref: audio !== undefined ? `media-${n}` : null,
    media_size: audio !== undefined ? 1000 : null,
    raw: {},
  };
}

export class CourseHarness {
  readonly repo = new MemoryCourseRepository();
  readonly channel = new FakeChannel();
  readonly tts = new FakeTTS();
  readonly stt = new FakeSTT();
  access = StudentAccess.parse({ user_id: 1, level: "A1", ui_lang: "pt" });
  config = defaultRuntimeConfig();
  now = new Date(); // the memory repo stamps lessons with the real clock
  readonly engine: CourseEngine;

  constructor(seed = 7) {
    const settings = testSettings();
    this.engine = new CourseEngine({
      repo: this.repo,
      content: content(),
      tts: this.tts,
      stt: this.stt,
      settings,
      limits: new UsageLimits(new MemoryCache(), settings),
      now: () => this.now,
      rng: seeded(seed),
    });
  }

  /** Send a text (or, with `audio`, a voice note whose fake transcript is `audio`). */
  async send(text: string | null, audio?: string): Promise<boolean> {
    this.channel.sent.length = 0;
    const msg = message(text, audio);
    if (audio !== undefined)
      this.channel.media.set(msg.media_ref as string, [Buffer.from(audio), "audio/ogg"]);
    return this.engine.handle({
      msg,
      access: this.access,
      channel: this.channel,
      config: this.config,
    });
  }

  get lesson() {
    return this.repo.lessons.at(-1);
  }

  get current(): Exercise {
    const ex = this.lesson?.current;
    if (!ex) throw new Error("no current exercise");
    return ex;
  }

  /** The right answer to the current exercise, as the student would send it. */
  rightAnswer(): [string | null, string | undefined] {
    const ex = this.current;
    if (ex.mode === "choice") return [`/ex ${ex.nonce}${ex.answer + 1}`, undefined];
    if (ex.mode === "voice") return [null, ex.accept[0]];
    return [ex.accept[0] ?? "", undefined];
  }

  last(): string {
    return this.channel.sent.at(-1)?.text ?? "";
  }
}
