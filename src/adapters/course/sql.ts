/** CourseRepository on Postgres (Drizzle). */
import { and, count, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { Exercise, MistakeData, Step } from "../../course/exercises.js";
import { cardFromJson, cardToJson } from "../../course/srs.js";
import type { Db } from "../../db/client.js";
import { courseAttempts, courseCards, courseLessons, mistakes, students } from "../../db/schema.js";
import type {
  Attempt,
  CardRow,
  CourseRepository,
  CourseStats,
  Lesson,
  LessonKind,
  LessonStatus,
} from "../../ports/course.js";

type LessonRow = typeof courseLessons.$inferSelect;
type CardDbRow = typeof courseCards.$inferSelect;

const OPEN: LessonStatus[] = ["active", "paused"];
// Only these conversation mistakes make good exercises (unclear audio and pronunciation don't).
const PRACTICE_TYPES = ["grammar", "vocabulary", "word_choice"];

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    studentId: row.studentId,
    kind: row.kind as LessonKind,
    status: row.status as LessonStatus,
    plan: row.plan as Step[],
    position: row.position,
    current: (row.current as Exercise | null) ?? null,
    correct: row.correct,
    answered: row.answered,
    points: row.points,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
  };
}

const toCard = (row: CardDbRow): CardRow => ({
  item: row.item,
  card: cardFromJson(row.fsrs),
  data: (row.data as MistakeData | null) ?? null,
});

export class SqlCourseRepository implements CourseRepository {
  constructor(private readonly db: Db) {}

  async openLesson(studentId: number): Promise<Lesson | null> {
    const [row] = await this.db
      .select()
      .from(courseLessons)
      .where(and(eq(courseLessons.studentId, studentId), inArray(courseLessons.status, OPEN)))
      .orderBy(desc(courseLessons.id))
      .limit(1);
    return row ? toLesson(row) : null;
  }

  async createLesson(studentId: number, kind: LessonKind, plan: Step[]): Promise<Lesson> {
    const [row] = await this.db
      .insert(courseLessons)
      .values({ studentId, kind, status: "active", plan })
      .returning();
    if (!row) throw new Error("lesson not created");
    return toLesson(row);
  }

  async saveLesson(lesson: Lesson): Promise<void> {
    const done = lesson.status === "done";
    await this.db
      .update(courseLessons)
      .set({
        status: lesson.status,
        plan: lesson.plan,
        position: lesson.position,
        current: lesson.current as unknown as Record<string, unknown> | null,
        correct: lesson.correct,
        answered: lesson.answered,
        points: lesson.points,
        updatedAt: sql`now()`,
        ...(done ? { finishedAt: sql`now()` } : {}),
      })
      .where(eq(courseLessons.id, lesson.id));
  }

  async lessonsSince(studentId: number, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(courseLessons)
      .where(
        and(
          eq(courseLessons.studentId, studentId),
          gte(courseLessons.startedAt, since),
          ne(courseLessons.status, "abandoned"),
          ne(courseLessons.kind, "placement"),
        ),
      );
    return row?.n ?? 0;
  }

  async lessonsDone(studentId: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(courseLessons)
      .where(
        and(
          eq(courseLessons.studentId, studentId),
          eq(courseLessons.status, "done"),
          ne(courseLessons.kind, "placement"),
        ),
      );
    return row?.n ?? 0;
  }

  async card(studentId: number, item: string): Promise<CardRow | null> {
    const row = await this.db.query.courseCards.findFirst({
      where: and(eq(courseCards.studentId, studentId), eq(courseCards.item, item)),
    });
    return row ? toCard(row) : null;
  }

  async dueCards(studentId: number, now: Date, limit: number): Promise<CardRow[]> {
    const rows = await this.db
      .select()
      .from(courseCards)
      .where(and(eq(courseCards.studentId, studentId), lte(courseCards.due, now)))
      .orderBy(courseCards.due)
      .limit(limit);
    return rows.map(toCard);
  }

  async knownItems(studentId: number): Promise<Set<string>> {
    const rows = await this.db
      .select({ item: courseCards.item })
      .from(courseCards)
      .where(eq(courseCards.studentId, studentId));
    return new Set(rows.map((r) => r.item));
  }

  async saveCard(studentId: number, row: CardRow): Promise<void> {
    const values = {
      due: row.card.due,
      fsrs: cardToJson(row.card),
      data: row.data as unknown as Record<string, unknown> | null,
    };
    await this.db
      .insert(courseCards)
      .values({ studentId, item: row.item, ...values })
      .onConflictDoUpdate({
        target: [courseCards.studentId, courseCards.item],
        set: { ...values, updatedAt: sql`now()` },
      });
  }

  async recordAttempt(a: Attempt): Promise<void> {
    await this.db.insert(courseAttempts).values({
      lessonId: a.lessonId,
      studentId: a.studentId,
      item: a.item,
      type: a.type,
      correct: a.correct,
      score: a.score,
      answer: a.answer ? [...a.answer].slice(0, 500).join("") : null,
    });
  }

  async recentSentences(studentId: number, since: Date): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ item: courseAttempts.item })
      .from(courseAttempts)
      .where(
        and(
          eq(courseAttempts.studentId, studentId),
          gte(courseAttempts.createdAt, since),
          sql`${courseAttempts.item} like 's:%'`,
        ),
      );
    return new Set(rows.map((r) => r.item.slice(2)));
  }

  async conversationMistakes(studentId: number, limit: number): Promise<MistakeData[]> {
    return this.db
      .select({
        original: mistakes.original,
        correction: mistakes.correction,
        explanation: mistakes.explanation,
      })
      .from(mistakes)
      .where(
        and(
          eq(mistakes.studentId, studentId),
          or(...PRACTICE_TYPES.map((t) => eq(mistakes.type, t))),
        ),
      )
      .orderBy(desc(mistakes.id))
      .limit(limit);
  }

  async stats(studentId: number, now: Date): Promise<CourseStats> {
    const [cards] = await this.db
      .select({
        words: sql<number>`count(*) filter (where ${courseCards.item} like 'w:%')`.mapWith(Number),
        due: sql<number>`count(*) filter (where ${courseCards.due} <= ${now.toISOString()})`.mapWith(
          Number,
        ),
      })
      .from(courseCards)
      .where(eq(courseCards.studentId, studentId));
    return {
      lessons: await this.lessonsDone(studentId),
      words: cards?.words ?? 0,
      due: cards?.due ?? 0,
    };
  }

  async saveLevel(studentId: number, level: string): Promise<void> {
    await this.db.update(students).set({ level }).where(eq(students.id, studentId));
  }
}
