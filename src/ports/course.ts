/** Where course progress lives: spaced-repetition cards, lessons and answered exercises. */
import type { Card } from "ts-fsrs";
import type { Exercise, MistakeData, Step } from "../course/exercises.js";

export type LessonKind = "lesson" | "review" | "placement";
export type LessonStatus = "active" | "paused" | "done" | "abandoned";

export interface Lesson {
  id: number;
  studentId: number;
  kind: LessonKind;
  status: LessonStatus;
  plan: Step[];
  position: number; // index of the step being answered
  current: Exercise | null; // the exercise waiting for an answer
  correct: number;
  answered: number;
  points: number;
  startedAt: Date;
  updatedAt: Date;
}

export interface CardRow {
  item: string;
  card: Card;
  data: MistakeData | null;
}

export interface Attempt {
  lessonId: number;
  studentId: number;
  item: string; // card item, or "s:<sentence id>"
  type: string;
  correct: boolean;
  score: number | null;
  answer: string | null;
}

export interface CourseStats {
  lessons: number; // finished
  words: number; // word cards
  due: number; // cards due now
}

export interface CourseRepository {
  /** The student's active or paused lesson, if any. */
  openLesson(studentId: number): Promise<Lesson | null>;
  createLesson(studentId: number, kind: LessonKind, plan: Step[]): Promise<Lesson>;
  saveLesson(lesson: Lesson): Promise<void>;
  /** Lessons and reviews started since `since` (not abandoned ones, not placement tests). */
  lessonsSince(studentId: number, since: Date): Promise<number>;
  /** Finished lessons and reviews, ever (not placement tests). */
  lessonsDone(studentId: number): Promise<number>;
  card(studentId: number, item: string): Promise<CardRow | null>;
  dueCards(studentId: number, now: Date, limit: number): Promise<CardRow[]>;
  knownItems(studentId: number): Promise<Set<string>>;
  saveCard(studentId: number, row: CardRow): Promise<void>;
  recordAttempt(attempt: Attempt): Promise<void>;
  /** Sentence ids practised since `since`. */
  recentSentences(studentId: number, since: Date): Promise<Set<string>>;
  /** The student's latest mistakes from the conversation (newest first). */
  conversationMistakes(studentId: number, limit: number): Promise<MistakeData[]>;
  stats(studentId: number, now: Date): Promise<CourseStats>;
  /** The placement test's result becomes the student's level. */
  saveLevel(studentId: number, level: string): Promise<void>;
}
