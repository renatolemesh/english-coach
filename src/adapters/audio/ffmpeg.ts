/** ffmpeg via child processes: any input -> 16 kHz mono PCM, and PCM -> OGG/Opus voice notes. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const STT_SAMPLE_RATE = 16_000;
// Containers that may keep their index at the end (non-"faststart" MP4/M4A from iPhones) cannot
// be demuxed from a non-seekable pipe; those go through a temp file.
const SEEKABLE_MIMES = new Set(["audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "video/mp4"]);

export class AudioError extends Error {}

export class FfmpegAudio {
  constructor(
    private readonly binary = "ffmpeg",
    private readonly timeoutS = 60,
  ) {}

  /** Mono float32 at 16 kHz. `maxSeconds` truncates the output (bounds memory/CPU for huge
   * files); decode max+1 s so callers can still detect "too long". */
  async decodePcm16k(data: Buffer, mime = "", maxSeconds?: number): Promise<Float32Array> {
    const limit = maxSeconds ? ["-t", (maxSeconds + 1).toFixed(0)] : [];
    const output = ["-f", "f32le", "-ac", "1", "-ar", String(STT_SAMPLE_RATE), ...limit, "pipe:1"];
    let out: Buffer;
    if (SEEKABLE_MIMES.has((mime.split(";")[0] ?? "").trim().toLowerCase())) {
      const file = path.join(tmpdir(), `sb-${randomBytes(8).toString("hex")}.m4a`);
      await writeFile(file, data);
      try {
        out = await this.run(["-i", file, ...output], Buffer.alloc(0));
      } finally {
        await rm(file, { force: true });
      }
    } else {
      out = await this.run(["-i", "pipe:0", ...output], data);
    }
    return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
  }

  /** 16 kHz mono PCM as a 16-bit WAV file (whisper.cpp's input). */
  static wav16k(pcm: Float32Array): Buffer {
    const header = Buffer.alloc(44);
    const bytes = pcm.length * 2;
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + bytes, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(STT_SAMPLE_RATE, 24);
    header.writeUInt32LE(STT_SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(bytes, 40);
    const body = Buffer.alloc(bytes);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
      body.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
    }
    return Buffer.concat([header, body]);
  }

  /** Mono PCM -> OGG/Opus 48 kHz, the format WhatsApp plays as a voice note. */
  async encodeOggOpus(
    samples: Float32Array,
    sampleRate: number,
    bitrateKbps = 32,
  ): Promise<Buffer> {
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return this.run(
      [
        "-f",
        "f32le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        `${bitrateKbps}k`,
        "-ac",
        "1",
        "-ar",
        "48000",
        "-application",
        "voip",
        "-f",
        "ogg",
        "pipe:1",
      ],
      pcm,
    );
  }

  /** Any audio -> MP3 mono: what every app player plays (iOS does not play OGG/Opus). */
  toMp3(data: Buffer, bitrateKbps = 48): Promise<Buffer> {
    return this.run(
      [
        "-i",
        "pipe:0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        `${bitrateKbps}k`,
        "-ac",
        "1",
        "-f",
        "mp3",
        "pipe:1",
      ],
      data,
    );
  }

  private run(args: string[], input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.binary, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill("SIGKILL"); // never leave ffmpeg running
        reject(new AudioError(`ffmpeg timed out after ${this.timeoutS}s`));
      }, this.timeoutS * 1000);
      proc.stdout.on("data", (c: Buffer) => out.push(c));
      proc.stderr.on("data", (c: Buffer) => err.push(c));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(new AudioError(`ffmpeg not runnable: ${e.message}`));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0)
          return reject(
            new AudioError(`ffmpeg failed (${code}): ${Buffer.concat(err).toString().slice(-500)}`),
          );
        const result = Buffer.concat(out);
        if (!result.length) return reject(new AudioError("ffmpeg produced no output"));
        resolve(result);
      });
      proc.stdin.on("error", () => {}); // ffmpeg may close stdin early on bad input
      proc.stdin.end(input);
    });
  }
}
