/**
 * TextToSpeech with Kokoro (kokoro-js, ONNX on CPU) -> OGG/Opus voice note.
 * Long text is split at sentence boundaries into chunks of at most CHUNK_CHARS, synthesized
 * separately and joined with a short pause. The model loads once per process. British voices
 * (b*) get British pronunciation from kokoro-js itself. fp32: the int8 model was 5x slower on
 * this CPU.
 */
import type { KokoroTTS as Kokoro } from "kokoro-js";
import type { Settings } from "../../config.js";
import { getLogger } from "../../logging.js";
import type { Cache } from "../../ports/cache.js";
import type { TextToSpeech } from "../../ports/media.js";
import type { FfmpegAudio } from "../audio/ffmpeg.js";
import { cacheKey } from "../cache/keys.js";
import { chunkText } from "./text.js";

const log = getLogger("coach.adapters.tts.kokoro");
export const PAUSE_S = 0.18;
export const BITRATES_KBPS = [32, 24, 16]; // try in order until the file fits VOICE_MAX_BYTES

export class TTSError extends Error {}

export class KokoroTTS implements TextToSpeech {
  private model: Promise<Kokoro> | null = null;
  private queue: Promise<unknown> = Promise.resolve(); // one synthesis at a time (CPU bound)

  constructor(
    private readonly settings: Settings,
    private readonly audio: FfmpegAudio,
    private readonly cache: Cache,
  ) {}

  /** Load the model once (idempotent); called at worker startup to avoid a cold start. */
  load(): Promise<Kokoro> {
    if (!this.model) {
      this.model = (async () => {
        // Built by hand: kokoro-js' from_pretrained cannot set the ONNX thread count, and
        // onnxruntime then starts one thread per host core, fighting the worker's CPU limit.
        const [{ KokoroTTS: K }, { AutoTokenizer, StyleTextToSpeech2Model, env }] =
          await Promise.all([import("kokoro-js"), import("@huggingface/transformers")]);
        env.cacheDir = this.settings.modelsDir; // downloaded at build time (scripts/download-models.ts)
        const id = this.settings.kokoroModel;
        const [onnx, tokenizer] = await Promise.all([
          StyleTextToSpeech2Model.from_pretrained(id, {
            dtype: this.settings.kokoroDtype,
            device: "cpu",
            session_options: {
              intraOpNumThreads: this.settings.ttsCpuThreads,
              interOpNumThreads: 1,
            },
          }),
          AutoTokenizer.from_pretrained(id),
        ]);
        const model = new K(onnx as never, tokenizer as never);
        log.info("tts_model_loaded");
        return model;
      })();
    }
    return this.model;
  }

  async synthesize(text: string, voice: string, speed: number): Promise<Buffer> {
    const s = this.settings;
    const key = cacheKey(
      "tts",
      text,
      voice,
      speed,
      BITRATES_KBPS,
      s.voiceMaxBytes,
      s.kokoroModel,
      s.kokoroDtype,
    );
    return this.cache.getOrSet(key, () => this.render(text, voice, speed), s.cacheTtlTtsS);
  }

  private async render(text: string, voice: string, speed: number): Promise<Buffer> {
    const chunks = chunkText(text);
    if (!chunks.length) throw new TTSError("nothing to synthesize");
    const job = this.queue.then(() => this.samples(chunks, voice, speed));
    this.queue = job.catch(() => undefined);
    const [samples, rate] = await job;
    for (const kbps of BITRATES_KBPS) {
      const ogg = await this.audio.encodeOggOpus(samples, rate, kbps);
      if (ogg.length <= this.settings.voiceMaxBytes) return ogg;
      log.warning("tts_too_big", { bytes: ogg.length, kbps });
    }
    throw new TTSError(`voice note exceeds ${this.settings.voiceMaxBytes} bytes at 16 kbps`);
  }

  private async samples(
    chunks: string[],
    voice: string,
    speed: number,
  ): Promise<[Float32Array, number]> {
    const model = await this.load();
    const parts: Float32Array[] = [];
    let rate = 24_000;
    for (const [i, chunk] of chunks.entries()) {
      const out = await model.generate(chunk, { voice: voice as never, speed });
      rate = out.sampling_rate;
      parts.push(out.audio as Float32Array);
      if (i < chunks.length - 1) parts.push(new Float32Array(Math.round(rate * PAUSE_S)));
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    return [joined, rate];
  }
}
