/** Fake STT: the "audio" bytes are the UTF-8 transcript (lets tests skip Whisper). A word
 * written as "word~0.2" gets that probability (default 0.95). */
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
    const words = audio
      .toString("utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        const [text = "", p] = w.split("~");
        return { text, p: p ? Number(p) : 0.95 };
      });
    return {
      text: words.map((w) => w.text).join(" "),
      language: "en",
      avg_logprob: this.avgLogprob,
      no_speech_prob: 0,
      duration_s: this.durationS,
      words,
    };
  }
}
