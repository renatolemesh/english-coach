// Voice help: Portuguese messages, the Transcrever/Traduzir
// buttons and the nudge towards audio.
import { describe, expect, it } from "vitest";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { voiceHelp } from "../../src/domain/choices.js";
import { formatText, EN as pt } from "../../src/domain/texts.js";
import type { Language } from "../../src/domain/translation.js";
import { translate } from "../../src/graph/nodes/translate.js";
import type { ConversationState } from "../../src/graph/state.js";
import { looksPortuguese } from "../../src/guardrails/input-rules.js";
import { audioMsg, Harness, started, textMsg } from "./harness.js";

describe("voice help", () => {
  it.each(["Olá", "Oi", "oi tudo bem?", "Eu gosto de pizza", "Hello, tudo bem?", "Obrigado"])(
    "portuguese is detected: %s",
    (text) => {
      expect(looksPortuguese(text)).toBe(true);
    },
  );

  it.each([
    "Hi",
    "I don't know",
    "I went to the praia yesterday", // a Portuguese word inside English is practice
    "I like feijoada",
    "My name is Carlos",
    "I am work in a bank since five years",
    "um I think so", // Whisper filler, also a Portuguese article
    "ok",
    "No",
    "No.",
    "no no no",
    "Ali",
    "Eu",
    "Casa",
    "Pedro e Ana",
  ])("english is not flagged: %s", (text) => {
    expect(looksPortuguese(text)).toBe(false);
  });

  it("portuguese text gets the english version instead of a grade", async () => {
    const h = await Harness.create();
    await started(h);
    h.llm.calls.length = 0;
    const state = await h.send(textMsg("Olá", 1));
    expect(h.llm.calls.map(([p]) => p)).toEqual(["translate"]); // no guard, evaluation or reply
    expect(h.kinds()).toEqual(["text"]);
    expect(h.texts()).toEqual([formatText(pt.portugueseHelp, { english: "[English] Olá" })]);
    expect(state.turn_count ?? 0).toBe(0);
  });

  it("portuguese help without translation", async () => {
    const h = await Harness.create();
    await started(h);
    delete h.llm.responses.translate;
    await h.send(textMsg("Eu gosto de pizza", 1));
    expect(h.texts()).toEqual([pt.portugueseHelpPlain]);
  });

  it("voice note is followed by buttons and they work", async () => {
    const h = await Harness.create();
    await started(h);
    h.channel.media.set("r1", [Buffer.from("I goed to the beach yesterday"), "audio/ogg"]);
    let state = await h.send(audioMsg("r1"));
    expect(h.kinds()).toEqual(["image", "voice", "choice"]);
    const reply = state.last_reply;
    expect(reply).toBeTruthy();

    await h.send(textMsg("/transcrever", 2));
    expect(h.texts()).toEqual([formatText(pt.transcript, { text: reply })]);

    h.llm.calls.length = 0;
    state = await h.send(textMsg("/traduzir", 3));
    expect(h.texts()).toEqual([formatText(pt.translation, { text: `[Portuguese] ${reply}` })]);
    expect(h.llm.calls.map(([p]) => p)).toEqual(["translate"]);
    expect(state.last_reply).toBe(reply); // commands do not replace it
  });

  it("translate failure and missing reply", async () => {
    const h = await Harness.create();
    await h.send(textMsg("/traduzir")); // before any voice note
    expect(h.texts()).toEqual([pt.noLastReply]);
    await started(h);
    delete h.llm.responses.translate;
    await h.send(textMsg("/traduzir", 2));
    expect(h.texts()).toEqual([pt.translateFailed]);
  });

  it("typed answers are nudged towards audio now and then", async () => {
    const h = await Harness.create();
    await started(h);
    const captions: string[] = [];
    for (let n = 0; n < 4; n++) {
      await h.send(textMsg(`I went to the beach with my friends ${n}`, n + 1));
      captions.push(h.channel.sent.find((s) => s.kind === "image")?.text ?? "");
    }
    expect(captions.map((c) => c.includes(pt.audioNudge))).toEqual([true, false, false, true]);
  });

  it("audio answers are not nudged", async () => {
    const h = await Harness.create();
    await started(h);
    h.channel.media.set("r1", [Buffer.from("I went to the beach"), "audio/ogg"]);
    await h.send(audioMsg("r1"));
    expect(h.channel.sent[0]?.text ?? "").not.toContain(pt.audioNudge);
  });

  it("portuguese audio gets audio wording", async () => {
    const h = await Harness.create();
    await started(h);
    h.channel.media.set("pt", [Buffer.from("Eu gosto de pizza"), "audio/ogg"]);
    await h.send(audioMsg("pt"));
    expect(h.texts()).toEqual([
      formatText(pt.portugueseHelpAudio, { english: "[English] Eu gosto de pizza" }),
    ]);
  });

  it("failed buttons do not lose the voice note", async () => {
    class BrokenButtons extends FakeChannel {
      override async sendChoice(): Promise<string> {
        throw new Error("meta down");
      }
    }
    const h = await Harness.create();
    h.channel = new BrokenButtons();
    const state = await h.send(textMsg("oi"));
    expect(h.kinds()).toEqual(["text", "text", "voice"]);
    expect(state.voice_notes).toBe(1);
  });

  it("text only channels get the hint only on the first voice notes", async () => {
    const h = await Harness.create();
    h.channel.interactive = false;
    await started(h); // voice note 1 (opener)
    const hints: boolean[] = [];
    for (let n = 0; n < 4; n++) {
      h.channel.media.set(`r${n}`, [Buffer.from("I went to the beach"), "audio/ogg"]);
      await h.send(audioMsg(`r${n}`));
      hints.push(h.texts().includes(voiceHelp(pt).fallbackText));
    }
    expect(hints).toEqual([true, true, false, false]);
  });

  it("translate rejects languages that are not code constants", async () => {
    const h = await Harness.create();
    const ctx = h.container.graphContext(h.channel);
    await expect(
      translate({} as ConversationState, ctx, "hi", "English", "Klingon</text>" as Language),
    ).rejects.toThrow();
    expect(h.llm.calls).toEqual([]);
  });
});
