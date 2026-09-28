/**
 * SpeechToText with whisper.cpp (`whisper-cli`, small.en, Silero VAD) on CPU.
 *
 * Decoding: English only, temperature 0 without fallback, no conditioning on previous text
 * (max-context 0: Whisper otherwise "fixes" the learner's mistakes), beam 5, and a soft VAD (threshold 0.3, 600 ms padding, 1 s minimum
 * silence) so quiet phone audio keeps its first word. The encoder context is sized to the
 * audio (plus a margin) instead of Whisper's fixed 30 s window: 3-5x faster on voice notes,
 * and on the test audios the transcripts were as good or better. Confidence = mean ln(p) of the text
 * tokens per segment, weighted by segment duration (compare with STT_*_CONFIDENCE).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Settings } from "../../config.js";
import { AudioTooLongError, type Transcript } from "../../domain/messages.js";
import { getLogger } from "../../logging.js";
import type { Cache } from "../../ports/cache.js";
import type { SpeechToText } from "../../ports/media.js";
import { FfmpegAudio, STT_SAMPLE_RATE } from "../audio/ffmpeg.js";
import { bytesKey } from "../cache/keys.js";

const log = getLogger("coach.adapters.stt.whisper_cpp");

// Part of the cache key: changing any of these invalidates cached transcripts.
export const PARAMS = {
  language: "en",
  temperature: 0,
  noFallback: true,
  maxContext: 0,
  beamSize: 5,
  vadThreshold: 0.3,
  vadSpeechPadMs: 600,
  vadMinSilenceMs: 1000,
  audioCtxMarginS: 3, // context = audio + margin (a tight context makes Whisper repeat itself)
} as const;

const CTX_PER_S = 50; // encoder frames per second of audio (1500 = 30 s)
const CTX_MAX = 1500;

/** Encoder context for `durationS` of audio, in multiples of 64 (whisper.cpp's -ac). */
export function audioCtx(durationS: number): number {
  const frames = (durationS + PARAMS.audioCtxMarginS) * CTX_PER_S;
  return Math.min(Math.ceil(frames / 64) * 64, CTX_MAX);
}

interface Segment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: { text: string; p: number }[];
}

export class STTError extends Error {}

export class WhisperCppSTT implements SpeechToText {
  private queue: Promise<unknown> = Promise.resolve(); // one decode at a time (CPU bound)

  constructor(
    private readonly settings: Settings,
    private readonly audio: FfmpegAudio,
    private readonly cache: Cache,
  ) {}

  async transcribe(audio: Buffer, mime: string): Promise<Transcript> {
    const s = this.settings;
    if (audio.length > s.maxAudioBytes)
      throw new AudioTooLongError(Number.POSITIVE_INFINITY, s.maxAudioSeconds);
    const key = bytesKey("stt-cpp", audio, path.basename(s.whisperModelPath), PARAMS);
    const cached = await this.cache.get(key);
    if (cached) {
      const transcript = JSON.parse(cached.toString()) as Transcript;
      this.checkDuration(transcript.duration_s); // the limit may have changed since
      return transcript;
    }
    const pcm = await this.audio.decodePcm16k(audio, mime, s.maxAudioSeconds);
    this.checkDuration(pcm.length / STT_SAMPLE_RATE); // before spending CPU on Whisper
    const job = this.queue.then(() => this.decode(pcm));
    this.queue = job.catch(() => undefined);
    const transcript = await job;
    await this.cache.set(key, Buffer.from(JSON.stringify(transcript)), s.cacheTtlSttS);
    return transcript;
  }

  private checkDuration(durationS: number): void {
    if (durationS > this.settings.maxAudioSeconds)
      throw new AudioTooLongError(durationS, this.settings.maxAudioSeconds);
  }

  private async decode(pcm: Float32Array): Promise<Transcript> {
    const s = this.settings;
    const base = path.join(tmpdir(), `stt-${randomBytes(8).toString("hex")}`);
    const duration = pcm.length / STT_SAMPLE_RATE;
    await writeFile(`${base}.wav`, FfmpegAudio.wav16k(pcm));
    try {
      await run(s.whisperCli, [
        "-m",
        s.whisperModelPath,
        "-f",
        `${base}.wav`,
        "-l",
        PARAMS.language,
        "-t",
        String(s.whisperCpuThreads),
        "-bs",
        String(PARAMS.beamSize),
        "-tp",
        String(PARAMS.temperature),
        "-nf",
        "-mc",
        String(PARAMS.maxContext),
        "-ac",
        String(audioCtx(duration)),
        "--vad",
        "-vm",
        s.whisperVadModelPath,
        "-vt",
        String(PARAMS.vadThreshold),
        "-vp",
        String(PARAMS.vadSpeechPadMs),
        "-vsd",
        String(PARAMS.vadMinSilenceMs),
        "-ojf",
        "-of",
        base,
        "-np",
      ]);
      const data = JSON.parse(await readFile(`${base}.json`, "utf8")) as {
        result?: { language?: string };
        transcription?: Segment[];
      };
      return toTranscript(data.transcription ?? [], data.result?.language ?? "en", duration);
    } finally {
      await Promise.all([rm(`${base}.wav`, { force: true }), rm(`${base}.json`, { force: true })]);
    }
  }
}

/** Segments -> Transcript (confidence = duration-weighted mean ln(p) of the text tokens). */
export function toTranscript(segments: Segment[], language: string, duration: number): Transcript {
  const scored = segments
    .map((seg) => {
      const tokens = (seg.tokens ?? []).filter((t) => !t.text.startsWith("[_") && t.p > 0);
      const avg = tokens.length
        ? tokens.reduce((sum, t) => sum + Math.log(t.p), 0) / tokens.length
        : -10;
      return {
        text: seg.text.trim(),
        avg,
        weight: Math.max((seg.offsets.to - seg.offsets.from) / 1000, 0.01),
      };
    })
    .filter((seg) => seg.text);
  if (!scored.length)
    return {
      text: "",
      language,
      avg_logprob: -10,
      no_speech_prob: 1,
      duration_s: round(duration, 2),
    };
  const total = scored.reduce((n, seg) => n + seg.weight, 0);
  const avg = scored.reduce((n, seg) => n + seg.avg * seg.weight, 0) / total;
  return {
    text: scored
      .map((seg) => seg.text)
      .join(" ")
      .trim(),
    language,
    avg_logprob: round(avg, 4),
    no_speech_prob: 0, // whisper-cli does not report it; the VAD drops silence instead
    duration_s: round(duration, 2),
  };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function run(cmd: string, args: string[], timeoutS = 120): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new STTError(`whisper-cli timed out after ${timeoutS}s`));
    }, timeoutS * 1000);
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new STTError(`whisper-cli not runnable: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        log.warning("stt_failed", { code, error: Buffer.concat(err).toString().slice(-300) });
        reject(new STTError(`whisper-cli failed (${code})`));
      }
    });
  });
}
