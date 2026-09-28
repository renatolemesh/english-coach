// What the plan offers (voices, speeds), the trial that becomes the free plan, the daily
// limit answer, the daily goal and the way up to the next level, through the graph.
import { beforeEach, describe, expect, it } from "vitest";
import { speedMenu, tutorMenu } from "../../src/domain/choices.js";
import type { Evaluation } from "../../src/domain/evaluation.js";
import { LEVEL_UP } from "../../src/domain/progress.js";
import { EN, formatText } from "../../src/domain/texts.js";
import { tutorOf } from "../../src/domain/tutors.js";
import type { TurnLog } from "../../src/ports/repository.js";
import { CONN, Harness, PHONE, started, textMsg } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await Harness.create();
  h.repo.plans.set("Grátis", { messages_per_day: 15, tutors: ["sarah"], speeds: [1, 0.9] });
  h.repo.plans.set("Teste Ilimitado", { duration_days: 30, next: "Grátis" });
});

async function student(plan: string, extra: Record<string, unknown> = {}) {
  const access = await h.repo.createStudent(CONN, PHONE, plan);
  h.repo.access.set(access.user_id, { ...access, ...extra });
  return access.user_id;
}

const pastTurn = (level: string, score: number): TurnLog => ({
  connection_id: CONN,
  phone: PHONE,
  topic: "travel",
  level,
  kind: "audio",
  transcript: "I went home",
  evaluation: { score } as Evaluation,
  reply_text: "Nice!",
  blocked_reason: null,
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  latency_ms: 0,
  errors: [],
  notes: [],
  prefs: null,
});

describe("what the plan offers", () => {
  it("a voice outside the plan is refused, for free, and the choice is not saved", async () => {
    const id = await student("Grátis", { messages_per_day: 2 });
    await started(h); // counts 1 of 2
    h.tts.calls.length = 0;
    await h.send(textMsg("/voz emma"));
    expect(h.texts()).toEqual([formatText(EN.tutorLocked, { tutor: "Emma", offered: "Sarah" })]);
    expect(h.tts.calls).toHaveLength(0);
    expect(h.repo.access.get(id)?.tutor).not.toBe("emma");
    await h.send(textMsg("/velocidade 70"));
    expect(h.texts()[0]).toBe(formatText(EN.speedLocked, { speed: "0.7x", offered: "1.0x, 0.9x" }));
    await h.send(textMsg("I like trains")); // the locked picks did not use the day's messages
    expect(h.kinds()[0]).toBe("image");
  });

  it("the menus mark what is locked", () => {
    const menu = tutorMenu(EN, tutorOf("sarah"), ["sarah"]);
    expect(menu.options.find((o) => o.id === "voz:emma")?.description).toContain(EN.paidOnly);
    expect(menu.options.find((o) => o.id === "voz:sarah")?.description).not.toContain("🔒");
    expect(menu.fallbackText).toContain(
      `/voice emma - Emma: British accent, female voice · ${EN.paidOnly}`,
    );
    const speeds = speedMenu(EN, 1, [1, 0.9]);
    expect(speeds.options.map((o) => o.description.includes("🔒"))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("a saved voice the plan does not offer plays as the plan's voice", async () => {
    await student("Grátis", { tutor: "george", speed: 0.7 });
    await started(h);
    await h.send(textMsg("I like trains"));
    const [, voice, speed] = h.tts.calls.at(-1) ?? [];
    expect([voice, speed]).toEqual(["af_heart", 0.9]); // Sarah; 0.7 -> the closest offered
  });
});

describe("plan changes and the daily limit", () => {
  it("an ended trial becomes the free plan, with a notice, and the turn runs", async () => {
    const id = await student("Teste Ilimitado", {
      plan_ends_at: new Date(Date.now() - 3600_000),
    });
    await h.send(textMsg("hi"));
    const notice = formatText(EN.planChanged, {
      old: "Teste Ilimitado",
      plan: "Grátis",
      limit: formatText(EN.planLimit, { n: 15 }),
      panel_url: "http://localhost:8000/panel",
    });
    expect(h.texts()[0]?.split(" Your progress")[0]).toBe(notice.split(" Your progress")[0]);
    expect(h.texts().length).toBeGreaterThan(1); // then the welcome
    expect(h.repo.access.get(id)).toMatchObject({ plan_name: "Grátis", messages_per_day: 15 });
  });

  it("the daily limit answer goes out once a day", async () => {
    await student("Grátis", { messages_per_day: 1 });
    await started(h);
    await h.send(textMsg("I like buses"));
    expect(h.texts()).toEqual([formatText(EN.blocked.daily_limit as string, { limit: 1 })]);
    await h.send(textMsg("hello?"));
    expect(h.channel.sent).toEqual([]);
  });
});

describe("goals", () => {
  it("cheers once when the daily goal is reached", async () => {
    await student("Teste Ilimitado", { daily_goal: 3 });
    await started(h);
    for (const n of [1, 2]) {
      await h.send(textMsg(`I like trains ${n}`));
      expect(h.texts().some((t) => t.startsWith("🎯"))).toBe(false);
    }
    await h.send(textMsg("I like trains 3"));
    expect(h.texts().at(-1)).toBe(formatText(EN.goalReached, { goal: 3 }));
    await h.send(textMsg("I like trains 4"));
    expect(h.texts().some((t) => t.startsWith("🎯"))).toBe(false);
  });

  it("/meta shows the day and the way up, and sets the goal", async () => {
    const id = await student("Teste Ilimitado");
    await started(h);
    await h.send(textMsg("I like trains"));
    await h.send(textMsg("/meta"));
    expect(h.texts()[0]).toContain("1 of 5 practices today");
    expect(h.texts()[0]).toContain(`Towards *B2*: 1 of ${LEVEL_UP.B1}`);
    await h.send(textMsg("/meta 12"));
    expect(h.texts()).toEqual([formatText(EN.goalSet, { goal: 12 })]);
    expect(h.repo.access.get(id)?.daily_goal).toBe(12);
  });

  it("the goal cannot be above the plan's daily limit", async () => {
    const id = await student("Grátis");
    await started(h);
    await h.send(textMsg("/meta 20"));
    expect(h.texts()).toEqual([formatText(EN.goalTooHigh, { limit: 15 })]);
    expect(h.repo.access.get(id)?.daily_goal).toBeNull();
    await h.send(textMsg("/meta 15"));
    expect(h.repo.access.get(id)?.daily_goal).toBe(15);
  });

  it("enough good answers move the student up a level", async () => {
    const id = await student("Teste Ilimitado");
    await started(h);
    const need = LEVEL_UP.B1 as number;
    for (let i = 0; i < need - 1; i++) await h.repo.saveTurn(id, pastTurn("B1", 80));
    await h.repo.saveTurn(id, pastTurn("B1", 50)); // not good enough: does not count
    const state = await h.send(textMsg("I like trains"));
    expect(h.texts().at(-1)).toBe(
      formatText(EN.levelUp, { previous: "B1", level: "B2", need, cmd: "/level" }),
    );
    expect(state.level).toBe("B2");
    expect(h.repo.access.get(id)?.level).toBe("B2");
  });
});
