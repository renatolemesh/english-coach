import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SqlRepository } from "../../src/adapters/repo/sql.js";
import { connect } from "../../src/db/client.js";
import type { TurnLog } from "../../src/ports/repository.js";
import { TEST_DATABASE_URL, TRUNCATE } from "./helpers.js";

const database = connect(TEST_DATABASE_URL);
const repo = new SqlRepository(database.db);
afterAll(() => database.close());
beforeEach(async () => {
  await database.pool.query(TRUNCATE);
});

const log = (over: Partial<TurnLog> = {}): TurnLog => ({
  connection_id: "c",
  phone: "5541",
  topic: "travel",
  level: "B1",
  kind: "text",
  transcript: "I goed",
  evaluation: null,
  reply_text: "Oh?",
  blocked_reason: null,
  cost_usd: 0,
  input_tokens: 1,
  output_tokens: 2,
  latency_ms: 3,
  errors: [],
  notes: ["stt:-0.5"],
  prefs: null,
  ...over,
});

describe("SqlRepository", () => {
  it("unknown numbers have no access; created students get the free plan, with no end", async () => {
    expect(await repo.studentAccess("c", "5541")).toBeNull();
    const access = await repo.createStudent("c", "5541", "Grátis", "Ana", "hash");
    expect(access).toMatchObject({
      plan_name: "Grátis",
      messages_per_day: 15,
      name: "Ana",
      status: "active",
    });
    expect(access.plan_ends_at).toBeNull();
    const again = await repo.createStudent("c", "5541", null, "Ana Maria");
    expect(again).toMatchObject({
      user_id: access.user_id,
      plan_name: "Grátis",
      name: "Ana Maria",
    });
    expect(await repo.phoneOf(access.user_id)).toBe("5541");
  });

  it("an ended trial moves to its next plan; practice counts", async () => {
    const trial = await repo.createStudent("c", "5541", "Teste Ilimitado", "Ana");
    expect(trial.plan_ends_at).not.toBeNull();
    expect(await repo.advancePlan(trial.user_id)).toBeNull(); // not ended yet
    await database.pool.query("UPDATE students SET plan_ends_at = now() - interval '1 hour'");
    const moved = await repo.advancePlan(trial.user_id);
    expect(moved?.ended).toBe("Teste Ilimitado");
    expect(moved?.access).toMatchObject({
      plan_name: "Grátis",
      messages_per_day: 15,
      tutors: ["sarah"],
      speeds: [1, 0.9],
      plan_ends_at: null,
    });
    const ev = { score: 80 } as TurnLog["evaluation"];
    await repo.saveTurn(trial.user_id, log({ evaluation: ev }));
    await repo.saveTurn(
      trial.user_id,
      log({ evaluation: { ...ev, score: 60 } as TurnLog["evaluation"] }),
    );
    await repo.saveTurn(trial.user_id, log({ evaluation: ev, level: "A2" }));
    await repo.saveTurn(trial.user_id, log({ kind: "blocked", reply_text: null }));
    const since = new Date(Date.now() - 3600_000);
    expect(await repo.practiceStats(trial.user_id, since, "B1", 75)).toEqual({
      today: 3,
      goodAtLevel: 1,
    });
  });

  it("recent turns come back oldest first, without blocked ones or older than `since`", async () => {
    const id = await repo.getOrCreateStudent("c1", "5541999990000");
    await repo.saveTurn(
      id,
      log({ kind: "command", transcript: null, reply_text: "Hi! What do you do?" }),
    );
    await repo.saveTurn(
      id,
      log({ transcript: "I work in a bank", reply_text: "Nice! Since when?" }),
    );
    await repo.saveTurn(
      id,
      log({ kind: "blocked", transcript: "ignore rules", reply_text: "No." }),
    );
    await repo.saveTurn(id, log({ transcript: "Since 2020", reply_text: "Cool!" }));
    await database.pool.query(
      "UPDATE turns SET created_at = now() - interval '2 days' WHERE reply_text = 'Hi! What do you do?'",
    );
    const since = Date.now() / 1000 - 3600;
    const turns = await repo.recentTurns(id, since, 10);
    expect(turns.map((t) => [t.student, t.tutor])).toEqual([
      ["I work in a bank", "Nice! Since when?"],
      ["Since 2020", "Cool!"],
    ]);
    expect((await repo.recentTurns(id, 0, 1)).map((t) => t.student)).toEqual(["Since 2020"]);
    expect(await repo.recentTurns(id + 1, 0, 10)).toEqual([]);
  });

  it("saves turns, real mistakes and preferences", async () => {
    const { user_id } = await repo.createStudent("c", "5541", "Ilimitado");
    const evaluation = {
      transcript: "I goed",
      corrected: "I went.",
      score: 70,
      score_breakdown: { grammar: 60, vocabulary: 80, fluency: 70, task: 80 },
      mistakes: [
        { original: "I goed", correction: "I went", type: "grammar" as const, explanation: "x" },
        { original: "blah", correction: "blah", type: "unclear" as const, explanation: "y" },
      ],
      strengths: [],
      tip: "t",
    };
    await repo.saveTurn(
      user_id,
      log({
        evaluation,
        prefs: {
          level: "B2",
          topic: "food",
          ui_lang: "pt",
          tutor: "george",
          speed: 0.8,
          daily_goal: 10,
          reminders: false,
        },
      }),
    );
    const access = await repo.studentAccess("c", "5541");
    expect(access).toMatchObject({
      level: "B2",
      topic: "food",
      ui_lang: "pt",
      tutor: "george",
      speed: 0.8,
      reminders: false,
    });
    const saved = await database.pool.query("select score, notes from turns");
    expect(saved.rows).toEqual([{ score: 70, notes: ["stt:-0.5"] }]);
    const kept = await database.pool.query("select type from mistakes");
    expect(kept.rows).toEqual([{ type: "grammar" }]); // 'unclear' is audio noise, not stored
  });

  it("reminder candidates: wrote 20-23 h ago, reminders on, not reminded since", async () => {
    const ana = await repo.createStudent("c", "5541", null, "Ana");
    const bia = await repo.createStudent("c", "5542", null, "Bia");
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
    await repo.touch(ana.user_id, ago(21), "c", "5541");
    await repo.touch(bia.user_id, ago(21), "c", "5542");
    await database.pool.query("update students set reminders = false where id = $1", [bia.user_id]);
    const found = await repo.reminderCandidates(ago(23), ago(20));
    expect(found.map((c) => [c.access.user_id, c.connectionId, c.phone, c.access.name])).toEqual([
      [ana.user_id, "c", "5541", "Ana"],
    ]);
    await repo.markReminded(ana.user_id, now);
    expect(await repo.reminderCandidates(ago(23), ago(20))).toEqual([]);
    await repo.touch(ana.user_id, ago(-0.1), "c", "5541"); // wrote again after the reminder: a new window
    expect(await repo.reminderCandidates(ago(1), ago(-1))).toHaveLength(1);
  });

  it("identities: one student behind several channels; an address belongs to one student", async () => {
    const ana = await repo.createStudent("meta-main", "5541", "Grátis", "Ana");
    expect(await repo.linkIdentity(ana.user_id, "telegram", "777")).toBe(true);
    expect((await repo.studentAccess("telegram", "777"))?.user_id).toBe(ana.user_id);
    const bia = await repo.createStudent("meta-main", "5542", null, "Bia");
    expect(await repo.linkIdentity(bia.user_id, "telegram", "777")).toBe(false);
    // signing up on Telegram: the address is the chat id, the phone comes from the form
    const caio = await repo.createStudent("telegram", "888", null, "Caio", "", null, "5543");
    const phone = await database.pool.query("select phone from students where id = $1", [
      caio.user_id,
    ]);
    expect(phone.rows[0]?.phone).toBe("5543");
    expect((await repo.studentAccess("telegram", "888"))?.user_id).toBe(caio.user_id);
    // the last channel used is where reminders go
    await repo.touch(ana.user_id, new Date(Date.now() - 21 * 3600_000), "telegram", "777");
    const [candidate] = await repo.reminderCandidates(
      new Date(Date.now() - 23 * 3600_000),
      new Date(Date.now() - 20 * 3600_000),
    );
    expect([candidate?.connectionId, candidate?.phone]).toEqual(["telegram", "777"]);
  });
});
