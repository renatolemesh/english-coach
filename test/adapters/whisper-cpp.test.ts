import { describe, expect, it } from "vitest";
import { audioCtx, toTranscript, wordsOf } from "../../src/adapters/stt/whisper-cpp.js";

describe("audioCtx", () => {
  it("sizes the encoder context to the audio plus a margin, in multiples of 64", () => {
    expect(audioCtx(2.12)).toBe(256);
    expect(audioCtx(4.26)).toBe(384);
    expect(audioCtx(11.78)).toBe(768);
  });
  it("never exceeds Whisper's 30 s window", () => {
    expect(audioCtx(60)).toBe(1500);
  });
});

describe("toTranscript", () => {
  const seg = (from: number, to: number, text: string, ps: number[]) => ({
    offsets: { from, to },
    text,
    tokens: [{ text: "[_BEG_]", p: 0.01 }, ...ps.map((p, i) => ({ text: `t${i}`, p }))],
  });

  it("weights each segment's mean ln(p) by its duration and skips special tokens", () => {
    const t = toTranscript(
      [seg(0, 1000, " Hi.", [1, 1]), seg(1000, 4000, " There.", [Math.E ** -1])],
      "en",
      4,
    );
    expect(t.text).toBe("Hi. There.");
    expect(t.avg_logprob).toBeCloseTo(-0.75, 4);
    expect(t.duration_s).toBe(4);
  });

  it("no speech gives an empty, low-confidence transcript", () => {
    const t = toTranscript([], "en", 2.5);
    expect(t).toMatchObject({ text: "", avg_logprob: -10, no_speech_prob: 1 });
  });
});

describe("wordsOf", () => {
  const seg = (tokens: [string, number][]) => ({
    offsets: { from: 0, to: 1000 },
    text: tokens.map(([t]) => t).join(""),
    tokens: tokens.map(([text, p]) => ({ text, p })),
  });

  it("joins sub-word tokens and keeps the lowest probability", () => {
    const words = wordsOf([
      seg([
        ["[_BEG_]", 1],
        [" I", 0.9],
        [" th", 0.6],
        ["inks", 0.95],
        [" so", 0.99],
        [".", 0.2],
      ]),
    ]);
    expect(words).toEqual([
      { text: "I", p: 0.9 },
      { text: "thinks", p: 0.6 },
      { text: "so.", p: 0.99 }, // punctuation does not lower it
    ]);
  });

  it("an opening quote does not glue two words (real case: 'The word is \"sheep.\"')", () => {
    const words = wordsOf([
      seg([
        [" The", 0.97],
        [" word", 0.99],
        [" is", 0.99],
        [' "', 0.9],
        ["she", 0.94],
        ["ep", 0.95],
        ['."', 0.99],
      ]),
    ]);
    expect(words.map((w) => w.text)).toEqual(["The", "word", "is", 'sheep."']);
  });
});
