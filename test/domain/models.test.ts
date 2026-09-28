import { describe, expect, it } from "vitest";
import { expired, StudentAccess } from "../../src/domain/accounts.js";
import { renderHistory, TurnRecord } from "../../src/domain/conversation.js";
import {
  AudioTooLongError,
  IncomingMessage,
  isConfident,
  Transcript,
} from "../../src/domain/messages.js";
import { Translation } from "../../src/domain/translation.js";

describe("domain models", () => {
  it("transcript confidence", () => {
    expect(isConfident(Transcript.parse({ text: "x", avg_logprob: -0.3 }), -1.0)).toBe(true);
    expect(isConfident(Transcript.parse({ text: "x", avg_logprob: -1.4 }), -1.0)).toBe(false);
    const noisy = Transcript.parse({ text: "x", avg_logprob: -0.1, no_speech_prob: 0.9 });
    expect(isConfident(noisy, -1.0)).toBe(false);
  });

  it("renders the history", () => {
    expect(renderHistory("", [])).toBe("(no history)");
    const turn = TurnRecord.parse({ student: "I like trains", tutor: "Why?" });
    expect(renderHistory("Talked about travel", [turn])).toBe(
      "Summary: Talked about travel\nStudent: I like trains\nTutor: Why?",
    );
    expect(() => TurnRecord.parse({ student: "x", tutor: "y".repeat(1001) })).toThrow();
  });

  it("incoming messages keep the `from` field", () => {
    const msg = IncomingMessage.parse({
      id: "wamid.1",
      from: "5511987654321",
      timestamp: 1_700_000_000,
      type: "text",
      text: "hi",
    });
    expect(msg.from).toBe("5511987654321");
    expect(msg.timestamp.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(msg.media_ref).toBeNull();
    expect(msg.raw).toEqual({});
    const iso = IncomingMessage.parse({ ...msg, timestamp: "2023-11-14T22:13:20Z" });
    expect(iso.timestamp.getTime()).toBe(msg.timestamp.getTime());
    expect(() => IncomingMessage.parse({ ...msg, type: "video" })).toThrow();
  });

  it("audio too long error", () => {
    const err = new AudioTooLongError(95.25, 60);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("audio has 95.2s, limit is 60s");
    expect(new AudioTooLongError(Number.POSITIVE_INFINITY, 60).message).toBe(
      "audio has infs, limit is 60s",
    );
  });

  it("translation forbids extra fields", () => {
    expect(Translation.parse({ text: "oi" })).toEqual({ text: "oi" });
    expect(() => Translation.parse({ text: "oi", note: "x" })).toThrow();
    expect(() => Translation.parse({ text: "x".repeat(701) })).toThrow();
  });

  it("student access expires at plan_ends_at", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const access = StudentAccess.parse({ user_id: 1 });
    expect(access.status).toBe("active");
    expect(expired(access, now)).toBe(false);
    const ended = StudentAccess.parse({ user_id: 1, plan_ends_at: "2026-09-28T12:00:00Z" });
    expect(expired(ended, now)).toBe(true);
    expect(expired(ended, new Date("2026-09-28T11:59:59Z"))).toBe(false);
  });
});

describe("formatFixed", () => {
  it("formats with 1 and 2 decimals, exact ties half to even", async () => {
    const { formatFixed } = await import("../../src/domain/format.js");
    // reference values: the exact binary value rounded half to even
    const cases: [number, number, string][] = [
      [95.25, 1, "95.2"],
      [95.35, 1, "95.3"], // 95.35 is 95.3499... in binary
      [0.25, 1, "0.2"],
      [0.75, 1, "0.8"],
      [-0.25, 1, "-0.2"],
      [2.5, 0, "2"],
      [3.5, 0, "4"],
      [1.005, 2, "1.00"],
      [0.125, 2, "0.12"],
      [0.8, 1, "0.8"],
      [1, 1, "1.0"],
    ];
    for (const [x, d, want] of cases) expect(formatFixed(x, d), `${x}`).toBe(want);
  });
});
