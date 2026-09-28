// Menus and idle through the graph (the pure tests are in
// test/domain/choices.test.ts, test/domain/openers.test.ts and test/domain/texts.test.ts).
// Menus (/menu, topic and level lists) and the fresh start after session_idle_hours.
import { describe, expect, it } from "vitest";
import { EN, formatText, PT, EN as pt } from "../../src/domain/texts.js";
import type { ConversationState } from "../../src/graph/state.js";
import {
  ACCOUNT_RATE_LIMIT,
  emptyUsage,
  type LLMClient,
  QUOTA_FLAG_KEY,
} from "../../src/ports/llm.js";
import { audioMsg, Harness, started, textMsg } from "./harness.js";

const students = (state: Partial<ConversationState>) =>
  (state.recent_turns ?? []).map((t) => t.student);

describe("menus and idle", () => {
  it("menu command typed or plain", async () => {
    const h = await Harness.create();
    await started(h);
    for (const [n, text] of ["/menu", "Menu"].entries()) {
      await h.send(textMsg(text, n + 1));
      expect(h.kinds()).toEqual(["choice"]);
      expect(h.channel.sent[0]?.text ?? "").toContain("reset");
    }
  });

  it("topic and level lists then a pick", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("/nivel", 1));
    expect(h.kinds()).toEqual(["choice"]);
    expect(h.channel.sent[0]?.text ?? "").toContain("nivel:C2");
    const state = await h.send(textMsg("/tema 4", 2)); // what a tap on row tema:4 sends
    expect(state.topic).toBe("travel");
  });

  it("text only channels get the menu as text", async () => {
    const h = await Harness.create();
    h.channel.interactive = false;
    await started(h);
    await h.send(textMsg("/tema", 1));
    expect(h.texts()).toEqual([pt.topicList]);
  });

  it("idle text restarts with a new question on the same topic", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("/tema travel", 1));
    await h.send(textMsg("I went to Chile last year", 2));
    await h.age(13);
    h.llm.calls.length = 0;
    const state = await h.send(textMsg("oi, voltei", 3));
    expect(h.texts()[0]).toBe(formatText(pt.welcomeBack, { topic: "travel" }));
    expect(h.kinds()).toEqual(["text", "voice", "choice"]);
    expect(h.llm.calls.map(([p]) => p)).toEqual(["topic_opener"]); // "oi, voltei" is not graded
    expect(state.topic).toBe("travel");
    expect(students(state)).toEqual(["/resume"]); // old turns dropped
  });

  it("idle audio is graded with a fresh context", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("I like trains", 1));
    await h.age(13);
    h.channel.media.set("r", [Buffer.from("I went to the beach"), "audio/ogg"]);
    h.llm.calls.length = 0;
    const state = await h.send(audioMsg("r"));
    const evaluate = h.llm.calls.find(([p]) => p === "evaluate_answer")?.[1];
    expect(evaluate?.history).not.toContain("I like trains");
    expect(students(state)).toEqual(["I went to the beach"]);
  });

  it("recent activity does not reset", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("I like trains", 1));
    await h.age(1);
    const state = await h.send(textMsg("I also like buses", 2));
    expect(state.recent_turns).toHaveLength(3); // opener, trains, buses
  });

  it("menus are not limited like messages", async () => {
    const h = await Harness.create();
    await started(h);
    for (let n = 0; n < 10; n++) {
      // well above RATE_LIMIT_PER_MINUTE (6)
      await h.send(textMsg("/menu", n + 1));
      expect(h.kinds(), String(n)).toEqual(["choice"]);
    }
  });

  it("menus have a looser limit of their own", async () => {
    const h = await Harness.create();
    await started(h);
    const kinds: string[] = [];
    for (let n = 0; n < 35; n++) {
      // FREE_COMMANDS_PER_MINUTE = 30
      await h.send(textMsg("/menu", n + 1));
      kinds.push(h.kinds()[0] ?? "");
    }
    expect(kinds.filter((k) => k === "choice")).toHaveLength(30);
    expect(kinds.at(-1)).toBe("text"); // then "Calma!"
  });

  it("a real answer after a break is graded", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("I like trains", 1));
    await h.age(13);
    const state = await h.send(textMsg("Last weekend I went to the beach with my friends", 2));
    expect(h.kinds()).toEqual(["image", "voice", "choice"]);
    expect(students(state)).toEqual(["Last weekend I went to the beach with my friends"]);
  });

  it("busy llm quota answers without a turn", async () => {
    const h = await Harness.create();
    await started(h);
    await h.container.cache.set(QUOTA_FLAG_KEY, Buffer.from("1"), 60);
    h.llm.calls.length = 0;
    await h.send(textMsg("I went to the beach", 1));
    expect(h.texts()).toEqual([pt.blocked.busy]);
    expect(h.llm.calls).toEqual([]);
    await h.send(textMsg("/menu", 2)); // menus still work
    expect(h.kinds()).toEqual(["choice"]);
  });

  it("guard quota failure is busy not graded", async () => {
    const h = await Harness.create();
    await started(h);
    const real: LLMClient["structured"] = h.llm.structured.bind(h.llm);
    const quota: LLMClient["structured"] = async (promptId, variables, model, fallback, meta) => {
      if (promptId === "guard_input") {
        return {
          value: fallback,
          usage: emptyUsage(),
          fallbackUsed: true,
          fallbackReason: ACCOUNT_RATE_LIMIT,
        };
      }
      return real(promptId, variables, model, fallback, meta);
    };
    h.llm.structured = quota;
    await h.send(textMsg("Write a Python function that sorts a list", 1));
    expect(h.texts()).toEqual([pt.blocked.busy]);
  });

  it("voice change replays the last reply in the new voice", async () => {
    const h = await Harness.create();
    await started(h);
    let state = await h.send(textMsg("I like trains", 1));
    const [last, turns] = [state.last_reply, state.recent_turns];
    h.llm.calls.length = 0;
    h.tts.calls.length = 0;
    state = await h.send(textMsg("/voz george", 2));
    expect(h.kinds()).toEqual(["text", "voice"]); // no LLM call, no buttons under a sample
    expect(h.texts()[0]).toContain("George");
    expect(h.llm.calls).toEqual([]);
    expect(h.tts.calls).toEqual([[last, "bm_george", 1.0]]);
    expect(state.tutor).toBe("george");
    expect(state.recent_turns).toEqual(turns); // not a new turn
    await h.send(textMsg("/velocidade 0,8", 3));
    expect(h.tts.calls.at(-1)).toEqual([last, "bm_george", 0.8]);
    await h.send(textMsg("I like buses", 4)); // the next reply keeps both choices
    expect(h.tts.calls.at(-1)?.slice(1)).toEqual(["bm_george", 0.8]);
    const opener = await h.send(textMsg("/reset", 5));
    expect([opener.tutor, opener.speed]).toEqual(["george", 0.8]); // preferences survive
    const tutor = h.llm.calls.find(([p]) => p === "topic_opener")?.[1].tutor ?? "";
    expect(tutor.startsWith("George, a man")).toBe(true);
  });

  it("voice and speed without argument show the lists", async () => {
    const h = await Harness.create();
    await started(h);
    for (const [n, text] of ["/voz", "/velocidade", "/voz bob"].entries()) {
      await h.send(textMsg(text, n + 1));
      expect(h.kinds()).toEqual(["choice"]);
    }
    await h.send(textMsg("/velocidade", 9));
    expect(h.channel.sent[0]?.text ?? "").toContain("velocidade:70");
  });

  it("language choice changes texts and menus and survives reset", async () => {
    const h = await Harness.create();
    await started(h);
    await h.send(textMsg("/idioma", 1));
    expect(h.kinds()).toEqual(["choice"]);
    expect(h.channel.sent[0]?.text ?? "").toContain("idioma:pt");
    let state = await h.send(textMsg("/idioma pt", 2));
    expect(state.ui_lang).toBe("pt");
    expect(h.texts()).toEqual([PT.languageSet]);
    await h.send(textMsg("/ajuda", 3));
    expect(h.texts()).toEqual([PT.help]);
    state = await h.send(textMsg("/reset", 4));
    expect(state.ui_lang).toBe("pt");
    expect(h.texts()[0]?.startsWith(PT.resetDone)).toBe(true);
    await h.send(textMsg("/language english", 5));
    expect(h.texts()).toEqual([EN.languageSet]);
  });
});
