/** The app as a channel: the bot's answers become app events (graph with fakes). */
import { describe, expect, it } from "vitest";
import { MemoryAppStore } from "../../src/adapters/app/memory.js";
import { AppChannel } from "../../src/adapters/channels/app.js";
import { audioMsg, Harness, textMsg } from "../graph/harness.js";

const ID = "1"; // the harness's only student: the app's address is the student id

async function appHarness() {
  const h = await Harness.create();
  const store = new MemoryAppStore();
  const mp3 = { toMp3: async (ogg: Buffer) => Buffer.concat([Buffer.from("MP3:"), ogg]) };
  const channel = new AppChannel(store, mp3);
  const send = (msg: ReturnType<typeof textMsg>) =>
    h.runner.handle({ ...msg, from: ID }, "app", h.container.graphContext(channel, h.config));
  const kinds = () => (store.eventsByStudent.get(1) ?? []).map((e) => e.kind);
  return { h, store, channel, send, kinds };
}

describe("AppChannel", () => {
  it("a voice message: the evaluation as data (no card rendered), the reply as MP3, buttons", async () => {
    const { store, send, kinds } = await appHarness();
    await send(textMsg("hi", 1)); // first contact: welcome and the spoken opener
    store.eventsByStudent.clear();
    const upload = await store.putMedia(
      1,
      Buffer.from("I goed to the beach yesterday"),
      "audio/webm",
    );
    await send({ ...audioMsg(upload), from: ID });
    expect(kinds()).toEqual(["evaluation", "voice", "choice"]);
    const [evaluation, voice, choice] = store.eventsByStudent.get(1) ?? [];
    expect((evaluation?.data as { score: number } | undefined)?.score).toBe(82);
    expect(evaluation?.text).toBe("Score: 82/100");
    const audio = await store.media(String(voice?.mediaId));
    expect([audio?.mime, audio?.data.subarray(0, 4).toString()]).toEqual(["audio/mpeg", "MP3:"]);
    const options = (choice?.data as { options: { id: string }[] } | undefined)?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
  });

  it("lessons work unchanged: exercises arrive as choices with their option ids", async () => {
    const { store, send } = await appHarness();
    await send(textMsg("/aula", 1));
    const [first] = store.eventsByStudent.get(1) ?? [];
    expect(first?.kind).toBe("choice");
    expect(first?.text).toContain("*1/");
    const options = (first?.data as { options: { id: string }[] } | undefined)?.options ?? [];
    expect(options[0]?.id).toMatch(/^ex:/);
  });

  it("rejects an address that is not a student id", async () => {
    const { channel } = await appHarness();
    await expect(channel.sendText("5541", "hi")).resolves.toBeDefined(); // a number: accepted
    await expect(channel.sendText("abc", "hi")).rejects.toThrow(/bad app address/);
  });
});
