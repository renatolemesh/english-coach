/** Fake STT: the "audio" bytes are the UTF-8 transcript (lets tests skip Whisper). */
import type { Transcript } from "../../domain/messages.js";
import type { SpeechToText } from "../../ports/media.js";

export class FakeSTT implements SpeechToText {
  calls = 0;
  constructor(
    public avgLogprob = -0.2,
    public durationS = 5,
  ) {}

  async transcribe(audio: Buffer): Promise<Transcript> {
    this.calls++;
    return {
      text: audio.toString("utf8").trim(),
      language: "en",
      avg_logprob: this.avgLogprob,
      no_speech_prob: 0,
      duration_s: this.durationS,
    };
  }
}
