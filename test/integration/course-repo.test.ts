// The course repository and a whole lesson on Postgres (coach_test).
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { SqlCourseRepository } from "../../src/adapters/course/sql.js";
import { SqlRepository } from "../../src/adapters/repo/sql.js";
import { FakeSTT } from "../../src/adapters/stt/fake.js";
import { FakeTTS } from "../../src/adapters/tts/fake.js";
import { PROJECT_ROOT } from "../../src/config.js";
import { CourseContent } from "../../src/course/content.js";
import { CourseEngine } from "../../src/course/engine.js";
import { review } from "../../src/course/srs.js";
import { connect } from "../../src/db/client.js";
import { UsageLimits } from "../../src/guardrails/limits.js";
import { PanelQueries } from "../../src/panel/queries.js";
import { message, seeded } from "../course/helpers.js";
import { testSettings } from "../graph/harness.js";
import { TEST_DATABASE_URL, TRUNCATE } from "./helpers.js";

const database = connect(TEST_DATABASE_URL);
const repo = new SqlCourseRepository(database.db);
afterAll(() => database.close());
beforeEach(async () => {
  await database.pool.query(TRUNCATE);
});

describe("SqlCourseRepository", () => {
  it("a placement test is not a lesson (limits, goal, ranking) and sets the level", async () => {
    const turns = new SqlRepository(database.db);
    const { user_id: id } = await turns.createStudent("c", "5511", "Grátis", "Ana");
    const test = await repo.createLesson(id, "placement", [{ type: "meaning", item: "w:x" }]);
    await repo.saveLesson({ ...test, status: "done", points: 0 });
    const midnight = new Date(Date.now() - 3600_000);
    expect(await repo.lessonsSince(id, midnight)).toBe(0);
    expect(await repo.lessonsDone(id)).toBe(0);
    expect((await turns.practiceStats(id, midnight, "B1", 75)).today).toBe(0);
    const progress = await new PanelQueries(database.db).progress(id, 1, "B1");
    expect(progress.today).toBe(0);
    await repo.saveLevel(id, "A2");
    expect((await turns.studentAccess("c", "5511"))?.level).toBe("A2");
  });

  it("cards, lessons, attempts and stats", async () => {
    const turns = new SqlRepository(database.db);
    const student = await turns.createStudent("c", "5511", "Grátis", "Ana");
    const id = student.user_id;
    expect(student.lessons_per_day).toBe(1);
    const now = new Date();
    await repo.saveCard(id, { item: "w:house.n", card: review(null, "again", now), data: null });
    await repo.saveCard(id, {
      item: "m:abc",
      card: review(null, "good", now),
      data: { original: "I am work", correction: "I work", explanation: "x" },
    });
    await repo.saveCard(id, { item: "w:house.n", card: review(null, "good", now), data: null }); // upsert
    expect([...(await repo.knownItems(id))].sort()).toEqual(["m:abc", "w:house.n"]);
    const later = new Date(now.getTime() + 3600_000);
    const due = await repo.dueCards(id, later, 10);
    expect(due.map((d) => d.item).sort()).toEqual(["m:abc", "w:house.n"]);
    expect(due.find((d) => d.item === "m:abc")?.data?.correction).toBe("I work");
    expect(due[0]?.card.due instanceof Date).toBe(true);

    const lesson = await repo.createLesson(id, "lesson", [{ type: "meaning", item: "w:house.n" }]);
    expect((await repo.openLesson(id))?.id).toBe(lesson.id);
    await repo.saveLesson({ ...lesson, status: "done", correct: 1, answered: 1, points: 6 });
    expect(await repo.openLesson(id)).toBeNull();
    expect(await repo.lessonsSince(id, new Date(now.getTime() - 60_000))).toBe(1);
    await repo.recordAttempt({
      lessonId: lesson.id,
      studentId: id,
      item: "s:s1",
      type: "order",
      correct: true,
      score: 100,
      answer: "I live in a big house",
    });
    expect([...(await repo.recentSentences(id, new Date(now.getTime() - 60_000)))]).toEqual(["s1"]);
    expect(await repo.stats(id, later)).toEqual({ lessons: 1, words: 1, due: 2 });
    // a finished lesson is a practice for the daily goal and points in the ranking
    expect((await turns.practiceStats(id, new Date(now.getTime() - 60_000), "B1", 75)).today).toBe(
      1,
    );
    const ranking = await new PanelQueries(database.db).ranking();
    expect(ranking).toEqual([{ studentId: id, name: "Ana", points: 6, practices: 1 }]);
  });

  it("a lesson end to end on Postgres", async () => {
    const turns = new SqlRepository(database.db);
    const access = await turns.createStudent("c", "5511", "Teste Ilimitado", "Bia");
    await database.pool.query(
      "INSERT INTO turns (student_id, kind, topic, level, cost_usd, input_tokens, output_tokens, latency_ms) VALUES ($1, 'text', 't', 'A1', 0, 0, 0, 0)",
      [access.user_id],
    );
    await database.pool.query(
      "INSERT INTO mistakes (student_id, turn_id, original, correction, type, explanation, topic) VALUES ($1, 1, 'I am agree', 'I agree', 'grammar', 'Agree is a verb: no am.', 't')",
      [access.user_id],
    );
    const settings = testSettings();
    const engine = new CourseEngine({
      repo,
      content: CourseContent.load(path.join(PROJECT_ROOT, "test/fixtures/course")),
      tts: new FakeTTS(),
      stt: new FakeSTT(),
      settings,
      limits: new UsageLimits(new MemoryCache(), settings),
      rng: seeded(3),
    });
    const channel = new FakeChannel();
    const turn = (text: string | null, audio?: string) => {
      const msg = message(text, audio);
      if (audio !== undefined)
        channel.media.set(msg.media_ref as string, [Buffer.from(audio), "audio/ogg"]);
      return engine.handle({
        msg,
        access: { ...access, level: "A1" },
        channel,
        config: defaultRuntimeConfig(),
      });
    };
    await turn("/aula");
    for (let i = 0; i < 20; i++) {
      const lesson = await repo.openLesson(access.user_id);
      const ex = lesson?.current;
      if (!ex) break;
      if (ex.mode === "choice") await turn(`/ex ${ex.nonce}${ex.answer + 1}`);
      else if (ex.mode === "voice") await turn(null, ex.accept[0]);
      else await turn(ex.accept[0] ?? "");
    }
    const [row] = (
      await database.pool.query("SELECT status, correct, answered, points FROM course_lessons")
    ).rows;
    expect(row.status).toBe("done");
    expect(row.correct).toBe(row.answered);
    const kinds = (await database.pool.query("SELECT item FROM course_cards")).rows.map(
      (r: { item: string }) => r.item[0],
    );
    expect(kinds).toContain("m"); // the conversation mistake became a card
    expect(channel.sent.at(-1)?.text).toContain("Aula concluída!"); // Portuguese, whatever ui_lang
  });
});
