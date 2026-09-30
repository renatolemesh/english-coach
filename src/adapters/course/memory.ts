/** In-memory CourseRepository for tests. */
import type { MistakeData, Step } from "../../course/exercises.js";
import type {
  Attempt,
  CardRow,
  CourseRepository,
  CourseStats,
  Lesson,
  LessonKind,
} from "../../ports/course.js";

export class MemoryCourseRepository implements CourseRepository {
  readonly lessons: Lesson[] = [];
  readonly cards = new Map<string, CardRow>(); // "student|item"
  readonly attempts: (Attempt & { at: Date })[] = [];
  readonly mistakes = new Map<number, MistakeData[]>();

  async openLesson(studentId: number): Promise<Lesson | null> {
    const open = this.lessons.filter(
      (l) => l.studentId === studentId && (l.status === "active" || l.status === "paused"),
    );
    const last = open.at(-1);
    return last ? structuredClone(last) : null;
  }

  async createLesson(studentId: number, kind: LessonKind, plan: Step[]): Promise<Lesson> {
    const now = new Date();
    const lesson: Lesson = {
      id: this.lessons.length + 1,
      studentId,
      kind,
      status: "active",
      plan,
      position: 0,
      current: null,
      correct: 0,
      answered: 0,
      points: 0,
      startedAt: now,
      updatedAt: now,
    };
    this.lessons.push(lesson);
    return structuredClone(lesson);
  }

  async saveLesson(lesson: Lesson): Promise<void> {
    const i = this.lessons.findIndex((l) => l.id === lesson.id);
    if (i >= 0) this.lessons[i] = { ...structuredClone(lesson), updatedAt: new Date() };
  }

  async lessonsSince(studentId: number, since: Date): Promise<number> {
    return this.lessons.filter(
      (l) => l.studentId === studentId && l.startedAt >= since && l.status !== "abandoned",
    ).length;
  }

  async lessonsDone(studentId: number): Promise<number> {
    return this.lessons.filter((l) => l.studentId === studentId && l.status === "done").length;
  }

  async card(studentId: number, item: string): Promise<CardRow | null> {
    const row = this.cards.get(`${studentId}|${item}`);
    return row ? structuredClone(row) : null;
  }

  async dueCards(studentId: number, now: Date, limit: number): Promise<CardRow[]> {
    return [...this.cards]
      .filter(([k, r]) => k.startsWith(`${studentId}|`) && r.card.due <= now)
      .map(([, r]) => r)
      .sort((a, b) => a.card.due.getTime() - b.card.due.getTime())
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async knownItems(studentId: number): Promise<Set<string>> {
    const prefix = `${studentId}|`;
    return new Set(
      [...this.cards.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
    );
  }

  async saveCard(studentId: number, row: CardRow): Promise<void> {
    this.cards.set(`${studentId}|${row.item}`, structuredClone(row));
  }

  async recordAttempt(attempt: Attempt): Promise<void> {
    this.attempts.push({ ...attempt, at: new Date() });
  }

  async recentSentences(studentId: number, since: Date): Promise<Set<string>> {
    return new Set(
      this.attempts
        .filter((a) => a.studentId === studentId && a.at >= since && a.item.startsWith("s:"))
        .map((a) => a.item.slice(2)),
    );
  }

  async conversationMistakes(studentId: number, limit: number): Promise<MistakeData[]> {
    return (this.mistakes.get(studentId) ?? []).slice(0, limit);
  }

  async stats(studentId: number, now: Date): Promise<CourseStats> {
    const known = await this.knownItems(studentId);
    return {
      lessons: await this.lessonsDone(studentId),
      words: [...known].filter((k) => k.startsWith("w:")).length,
      due: (await this.dueCards(studentId, now, 10_000)).length,
    };
  }
}
