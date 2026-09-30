// Lessons through the course engine: start, answer (tap, type, speak), finish, pause, limits.
import { beforeEach, describe, expect, it } from "vitest";
import { COURSE_PT } from "../../src/course/texts.js";
import { formatText } from "../../src/domain/texts.js";
import { CourseHarness } from "./helpers.js";

let h: CourseHarness;

beforeEach(() => {
  h = new CourseHarness();
});

async function finishLesson(wrongAt = -1): Promise<number> {
  let answered = 0;
  while (h.lesson?.status === "active" && answered < 20) {
    const [text, audio] =
      answered === wrongAt ? ["/ex " + h.current.nonce + "0", undefined] : h.rightAnswer();
    await h.send(text, audio);
    answered++;
  }
  return answered;
}

describe("course lessons", () => {
  it("/aula starts a lesson with new words, one message per exercise", async () => {
    expect(await h.send("/aula")).toBe(true);
    const plan = h.lesson?.plan ?? [];
    expect(plan.length).toBeGreaterThanOrEqual(8);
    expect(plan.filter((s) => s.fresh && s.item?.startsWith("w:")).length).toBeGreaterThanOrEqual(
      2,
    );
    const choice = h.channel.sent.find((s) => s.kind === "choice")?.text ?? "";
    expect(choice.startsWith(COURSE_PT.firstLesson)).toBe(true);
    expect(choice).toContain(`*1/${plan.length}*`);
    expect(choice).toContain(`ex:${h.current.nonce}1`);
    expect(h.channel.sent.filter((s) => s.kind === "text")).toEqual([]);
  });

  it("a whole lesson: every answer right, cards scheduled, a summary with points", async () => {
    await h.send("/aula");
    const total = h.lesson?.plan.length ?? 0;
    const answered = await finishLesson();
    expect(answered).toBe(total);
    const done = h.repo.lessons.at(-1);
    expect(done?.status).toBe("done");
    expect(done?.correct).toBe(total);
    expect(done?.points).toBe(total + 5);
    expect(h.last()).toContain(
      formatText(COURSE_PT.finished, { correct: total, total, points: total + 5 }),
    );
    expect(h.last()).toContain("[aula menu]"); // nothing due yet: no review button
    const cards = [...h.repo.cards.keys()];
    expect(cards.some((k) => k.startsWith("1|w:"))).toBe(true);
    // every answer went in as an attempt; sentence practice recorded by sentence id
    expect(h.repo.attempts.length).toBe(total);
    expect(h.repo.attempts.some((a) => a.item.startsWith("s:"))).toBe(true);
  });

  it("feedback on the last answer goes on top of the next question", async () => {
    await h.send("/aula");
    const first = h.current;
    await h.send(`/ex ${first.nonce}${first.answer + 1}`);
    const next = h.channel.sent.filter((s) => s.kind === "choice").at(-1)?.text ?? "";
    expect(next.startsWith("✅")).toBe(true);
    expect(next).toContain("*2/");
  });

  it("a wrong answer shows the right one and brings the card back soon", async () => {
    await h.send("/aula");
    const ex = h.current;
    const wrong = ex.answer === 0 ? 2 : 1;
    await h.send(`/ex ${ex.nonce}${wrong}`);
    expect(h.channel.sent.at(-1)?.text).toContain("❌");
    const card = h.repo.cards.get(`1|${ex.item}`)?.card;
    expect(card?.due.getTime()).toBeLessThan(h.now.getTime() + 3600_000);
  });

  it("typed numbers and option text work; anything else gets a hint", async () => {
    await h.send("/aula");
    const ex = h.current;
    await h.send("banana");
    expect(h.last()).toBe(formatText(COURSE_PT.chooseHint, { n: ex.options.length }));
    expect(h.current.nonce).toBe(ex.nonce); // still the same exercise
    await h.send(String(ex.answer + 1));
    expect(h.lesson?.position).toBe(1);
  });

  it("a button from an old exercise is refused", async () => {
    await h.send("/aula");
    const old = h.current;
    await h.send(`/ex ${old.nonce}${old.answer + 1}`);
    await h.send(`/ex ${old.nonce}1`);
    expect(h.last()).toBe(COURSE_PT.stale);
    expect(h.lesson?.position).toBe(1);
  });

  it("another command pauses the lesson; /aula resumes it", async () => {
    await h.send("/aula");
    const ex = h.current;
    expect(await h.send("/menu")).toBe(false); // the conversation shows the menu
    expect(h.lesson?.status).toBe("paused");
    expect(await h.send("hello there")).toBe(false); // paused: this is conversation
    await h.send("/aula");
    expect(h.lesson?.status).toBe("active");
    expect(h.current.nonce).toBe(ex.nonce);
    expect(h.last().startsWith(COURSE_PT.resumed)).toBe(true);
    await h.send("/sair");
    expect(h.last()).toBe(COURSE_PT.paused);
  });

  it("a lesson left alone for hours stops taking answers", async () => {
    await h.send("/aula");
    h.now = new Date(h.now.getTime() + 3 * 3600_000);
    expect(await h.send("I went to the beach")).toBe(false);
    expect(h.lesson?.status).toBe("paused");
  });

  it("the plan's lessons per day", async () => {
    h.access = { ...h.access, lessons_per_day: 1 };
    await h.send("/aula");
    await finishLesson();
    await h.send("/aula");
    expect(h.last()).toBe(formatText(COURSE_PT.dailyLimit, { n: 1 }));
    h.now = new Date(h.now.getTime() + 24 * 3600_000); // tomorrow
    await h.send("/aula");
    expect(h.lesson?.status).toBe("active");
  });

  it("audio exercises send a voice note first; speaking is graded from the transcript", async () => {
    await h.send("/aula");
    let guard = 0;
    while (h.current.mode !== "voice" && guard++ < 20) {
      const [text, audio] = h.rightAnswer();
      await h.send(text, audio);
    }
    const ex = h.current;
    expect(ex.mode).toBe("voice");
    await h.send("some text");
    expect(h.last()).toBe(COURSE_PT.voiceHint);
    const words = (ex.accept[0] ?? "").replace(/[.!?]$/, "").split(" ");
    words[1] = `${words[1]}~0.2`; // one word came through unclear
    await h.send(null, words.join(" "));
    const feedback = h.channel.sent.filter((s) => s.kind === "choice").at(-1)?.text ?? "";
    expect(feedback).toMatch(/🎙️ \*\d+\/100\*/);
    expect(feedback).toContain("Treine:");
  });

  it("the next exercise's audio is rendered while the student answers the current one", async () => {
    await h.send("/aula");
    const audio = new Set(["listen", "dictation", "repeat", "pair"]);
    for (let i = 0; i < 12; i++) {
      const lesson = h.lesson;
      const next = lesson?.plan[(lesson?.position ?? 0) + 1];
      if (next && audio.has(next.type)) {
        expect(next.ready?.audio).toBeTruthy();
        expect(h.tts.calls.map((c) => c[0])).toContain(next.ready?.audio);
        const [text, voice] = h.rightAnswer();
        await h.send(text, voice);
        expect(h.current.nonce).toBe(next.ready?.nonce); // the prepared exercise is the one shown
        return;
      }
      const [text, voice] = h.rightAnswer();
      await h.send(text, voice);
    }
    throw new Error("no audio exercise in the lesson");
  });

  it("an unclear recording is not graded", async () => {
    await h.send("/aula");
    for (let i = 0; i < 20 && h.current.mode !== "voice"; i++) {
      const [text, audio] = h.rightAnswer();
      await h.send(text, audio);
    }
    const position = h.lesson?.position;
    h.stt.avgLogprob = -5;
    await h.send(null, "mumble");
    expect(h.last()).toBe(COURSE_PT.spokenRetry);
    expect(h.lesson?.position).toBe(position);
  });

  it("mistakes from the conversation become exercises", async () => {
    h.repo.mistakes.set(1, [
      { original: "I am work", correction: "I work", explanation: "Use the simple present." },
    ]);
    await h.send("/aula");
    const step = h.lesson?.plan.find((s) => s.type === "mistake");
    expect(step?.data?.original).toBe("I am work");
    await finishLesson();
    const card = [...h.repo.cards.values()].find((c) => c.item.startsWith("m:"));
    expect(card?.data?.correction).toBe("I work");
  });

  it("/revisar with nothing due; later the reviews come back", async () => {
    await h.send("/revisar");
    expect(h.last()).toBe(COURSE_PT.nothingToReview);
    await h.send("/aula");
    await finishLesson();
    h.now = new Date(h.now.getTime() + 30 * 86_400_000);
    await h.send("/revisar");
    expect(h.lesson?.kind).toBe("review");
    expect(h.last()).toContain("*Revisão 1/");
  });

  it("messages that are not for the course go to the conversation", async () => {
    expect(await h.send("I like football")).toBe(false);
    expect(await h.send("/tema")).toBe(false);
    expect(h.channel.sent).toEqual([]);
  });
});
