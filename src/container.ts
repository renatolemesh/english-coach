/**
 * The only place that picks implementations (from Settings). Nothing else creates clients.
 * Heavy media adapters (Whisper, Kokoro, Chromium) are built only with `withMedia` (worker).
 */
import path from "node:path";
import { AccountGate } from "./accounts/gate.js";
import type { RuntimeConfig } from "./accounts/runtime.js";
import { defaultRuntimeConfig } from "./accounts/runtime.js";
import { RuntimeConfigStore } from "./accounts/runtime-store.js";
import { MemoryCache } from "./adapters/cache/memory.js";
import { RedisCache } from "./adapters/cache/redis.js";
import { MemoryCourseRepository } from "./adapters/course/memory.js";
import { SqlCourseRepository } from "./adapters/course/sql.js";
import { FakeImageRenderer } from "./adapters/image/fake.js";
import { FakeLLM } from "./adapters/llm/fake.js";
import { modelSetup, OpenRouterLLM, OpenRouterTransport } from "./adapters/llm/openrouter.js";
import { MemoryRepository } from "./adapters/repo/memory.js";
import { SqlRepository } from "./adapters/repo/sql.js";
import { FakeSTT } from "./adapters/stt/fake.js";
import { FakeTTS } from "./adapters/tts/fake.js";
import { fallbackModels, PROJECT_ROOT, type Settings } from "./config.js";
import { CourseContent } from "./course/content.js";
import { CourseEngine } from "./course/engine.js";
import { connect, type Database } from "./db/client.js";
import type { GraphContext } from "./graph/context.js";
import { UsageLimits } from "./guardrails/limits.js";
import type { Cache } from "./ports/cache.js";
import type { ChatChannel } from "./ports/channel.js";
import type { CourseRepository } from "./ports/course.js";
import type { LLMClient } from "./ports/llm.js";
import type { ImageRenderer, SpeechToText, TextToSpeech } from "./ports/media.js";
import type { TurnRepository } from "./ports/repository.js";
import type { Retriever } from "./ports/retriever.js";
import { PromptRegistry } from "./prompts/registry.js";
import { buildRetriever } from "./rag/build.js";

export interface Media {
  stt: SpeechToText;
  tts: TextToSpeech;
  image: ImageRenderer;
  warmUp?(): Promise<void>;
  close?(): Promise<void>;
}

export type MediaFactory = (settings: Settings, cache: Cache) => Promise<Media>;

export class Container {
  constructor(
    readonly settings: Settings,
    readonly cache: Cache,
    readonly prompts: PromptRegistry,
    public llm: LLMClient,
    public repo: TurnRepository,
    public retriever: Retriever,
    readonly limits: UsageLimits,
    public media: Media | null,
    readonly database: Database | null,
    public courseRepo: CourseRepository = database
      ? new SqlCourseRepository(database.db)
      : new MemoryCourseRepository(),
  ) {}

  /** The course content (data/course), loaded on first use. */
  get courseContent(): CourseContent {
    return CourseContent.load(path.join(this.settings.dataDir, "course"));
  }

  /** Panel settings (app_settings); defaults without a database. */
  get runtime(): RuntimeConfigStore {
    return new RuntimeConfigStore(this.database?.db ?? null, this.cache);
  }

  requireMedia(): Media {
    if (!this.media) throw new Error("media adapters not built (use withMedia)");
    return this.media;
  }

  /** Per-message dependencies for the graph (the channel is the message's connection). */
  graphContext(channel: ChatChannel, config: RuntimeConfig = defaultRuntimeConfig()): GraphContext {
    const media = this.requireMedia();
    const panelUrl = `${this.settings.publicBaseUrl.replace(/\/+$/, "")}/panel`;
    return {
      settings: this.settings,
      llm: this.llm,
      prompts: this.prompts,
      stt: media.stt,
      tts: media.tts,
      image: media.image,
      channel,
      repo: this.repo,
      retriever: this.retriever,
      limits: this.limits,
      gate: new AccountGate(this.repo, this.cache, panelUrl),
      config,
      course: new CourseEngine({
        repo: this.courseRepo,
        content: this.courseContent,
        tts: media.tts,
        stt: media.stt,
        settings: this.settings,
        limits: this.limits,
      }),
    };
  }

  async close(): Promise<void> {
    await this.media?.close?.();
    await this.cache.close();
    await this.database?.close();
  }
}

export function fakeMedia(): Media {
  return { stt: new FakeSTT(), tts: new FakeTTS(), image: new FakeImageRenderer() };
}

export async function buildContainer(
  settings: Settings,
  opts: { withMedia?: boolean; media?: MediaFactory } = {},
): Promise<Container> {
  const cache: Cache = settings.useFakes
    ? new MemoryCache()
    : RedisCache.fromUrl(settings.redisUrl);
  const prompts = new PromptRegistry(settings.promptsDir, PROJECT_ROOT, settings.promptCanary);
  const database = settings.useFakes ? null : connect(settings.databaseUrl);
  const repo: TurnRepository = database ? new SqlRepository(database.db) : new MemoryRepository();
  const llm: LLMClient = settings.useFakes
    ? new FakeLLM(prompts)
    : new OpenRouterLLM(
        settings,
        prompts,
        cache,
        new OpenRouterTransport(settings),
        modelSetup(settings, fallbackModels(settings)),
      );
  let media: Media | null = null;
  if (opts.withMedia)
    media = settings.useFakes || !opts.media ? fakeMedia() : await opts.media(settings, cache);
  return new Container(
    settings,
    cache,
    prompts,
    llm,
    repo,
    buildRetriever(settings, cache, database),
    new UsageLimits(cache, settings),
    media,
    database,
  );
}

export const dataPath = (settings: Settings, ...parts: string[]) =>
  path.join(settings.dataDir, ...parts);
