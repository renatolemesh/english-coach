import { describe, expect, it } from "vitest";
import { audioMsg, Harness, started, textMsg } from "./harness.js";

describe("graph smoke", () => {
  it("first contact gets the welcome and a spoken opener", async () => {
    const h = await Harness.create();
    await h.send(textMsg("oi"));
    expect(h.kinds()).toEqual(["text", "text", "voice", "choice"]);
    expect(h.llm.calls.map(([p]) => p)).toEqual(["topic_opener"]);
  });

  it("an audio turn sends the image then the voice, evaluation before reply", async () => {
    const h = await Harness.create();
    await started(h);
    h.channel.media.set("r1", [Buffer.from("I goed to the beach yesterday"), "audio/ogg"]);
    const state = await h.send(audioMsg("r1"));
    expect(h.kinds()).toEqual(["image", "voice", "choice"]);
    expect(h.channel.sent[0]?.text).toBe("Score: 82/100");
    expect(h.llm.calls.map(([p]) => p)).toEqual([
      "guard_input",
      "evaluate_answer",
      "conversation_reply",
    ]);
    expect(h.llm.calls.at(-1)?.[1].correction).toBe("No mistakes.");
    expect(state.turn_count).toBe(1);
    expect(state.recent_turns?.at(-1)?.student).toBe("I goed to the beach yesterday");
  });
});
