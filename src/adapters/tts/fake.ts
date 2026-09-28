/** Fake TTS: a deterministic marker instead of audio. */
import type { TextToSpeech } from "../../ports/media.js";

export class FakeTTS implements TextToSpeech {
  readonly calls: [string, string, number][] = [];

  async synthesize(text: string, voice: string, speed: number): Promise<Buffer> {
    this.calls.push([text, voice, speed]);
    return Buffer.from(`OggS-fake:${text}`);
  }
}
