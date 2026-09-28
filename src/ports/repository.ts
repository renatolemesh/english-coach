/** Where turns, mistakes and students live (Postgres; memory in tests). */
import type { Preferences, StudentAccess } from "../domain/accounts.js";
import type { Evaluation } from "../domain/evaluation.js";

/** Everything persisted about one processed message. */
export interface TurnLog {
  connection_id: string;
  phone: string;
  topic: string;
  level: string;
  kind: string; // audio | text | command | blocked
  transcript: string | null;
  evaluation: Evaluation | null;
  reply_text: string | null;
  blocked_reason: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  errors: string[];
  notes: string[]; // model output the code had to fix, STT confidence
  prefs: Preferences | null; // saved on the student (the panel shows and edits them)
}

/** A past exchange, to rebuild the conversation memory when the thread has none. */
export interface PastTurn {
  student: string; // transcript ("" for a command such as the first opener)
  tutor: string;
  topic: string;
  at: number; // epoch seconds
}

export interface TurnRepository {
  /** Stable user_id for (connection, phone) (scripts; the bot uses studentAccess). */
  getOrCreateStudent(connectionId: string, phone: string): Promise<number>;
  /** Status, plan and preferences of a known student; null for an unknown number. */
  studentAccess(connectionId: string, phone: string): Promise<StudentAccess | null>;
  /** A verified student on `planName` (its duration starts now), or the existing one with the
   * new name/password (signing up again from the same WhatsApp). */
  createStudent(
    connectionId: string,
    phone: string,
    planName: string | null,
    name?: string,
    passwordHash?: string,
  ): Promise<StudentAccess>;
  /** When the student's plan ended and has a next plan, move there: the new access and the
   * name of the plan that ended. Null when nothing changed. */
  advancePlan(userId: number): Promise<{ access: StudentAccess; ended: string } | null>;
  setPassword(userId: number, passwordHash: string): Promise<void>;
  phoneOf(userId: number): Promise<string | null>;
  /** Store the turn, the student's mistakes (not 'unclear'), topic/level and preferences. */
  saveTurn(userId: number, log: TurnLog): Promise<void>;
  /** The last `limit` exchanges with a tutor reply since `sinceS` (epoch seconds), oldest first. */
  recentTurns(userId: number, sinceS: number, limit: number): Promise<PastTurn[]>;
  /** Evaluated practices since `since` (today) and good ones (score >= minScore) at `level`. */
  practiceStats(
    userId: number,
    since: Date,
    level: string,
    minScore: number,
  ): Promise<{ today: number; goodAtLevel: number }>;
}
