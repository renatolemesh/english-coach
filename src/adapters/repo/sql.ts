/** TurnRepository on Postgres (Drizzle). */
import { and, count, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { advanceEndedPlan } from "../../db/plan-changes.js";
import { mistakes, plans, students, turns } from "../../db/schema.js";
import {
  type Preferences,
  type StudentAccess,
  StudentAccess as StudentAccessSchema,
} from "../../domain/accounts.js";
import type { PastTurn, TurnLog, TurnRepository } from "../../ports/repository.js";

type StudentRow = typeof students.$inferSelect;
type PlanRow = typeof plans.$inferSelect;

export function toAccess(student: StudentRow, plan: PlanRow | null): StudentAccess {
  return StudentAccessSchema.parse({
    user_id: student.id,
    status: student.status,
    plan_name: plan?.name ?? null,
    messages_per_day: plan?.messagesPerDay ?? null,
    plan_ends_at: student.planEndsAt,
    tutors: plan?.tutors ?? null,
    speeds: plan?.speeds ?? null,
    name: student.name,
    level: student.level,
    topic: student.topic,
    ui_lang: student.uiLang,
    tutor: student.tutor,
    speed: student.speed,
    daily_goal: student.dailyGoal,
  });
}

export class SqlRepository implements TurnRepository {
  constructor(private readonly db: Db) {}

  async getOrCreateStudent(connectionId: string, phone: string): Promise<number> {
    await this.db.insert(students).values({ connectionId, phone }).onConflictDoNothing();
    const row = await this.db.query.students.findFirst({
      columns: { id: true },
      where: and(eq(students.connectionId, connectionId), eq(students.phone, phone)),
    });
    if (!row) throw new Error("student vanished");
    return row.id;
  }

  async studentAccess(connectionId: string, phone: string): Promise<StudentAccess | null> {
    const rows = await this.db
      .select({ student: students, plan: plans })
      .from(students)
      .leftJoin(plans, eq(plans.id, students.planId))
      .where(and(eq(students.connectionId, connectionId), eq(students.phone, phone)))
      .limit(1);
    const row = rows[0];
    return row ? toAccess(row.student, row.plan) : null;
  }

  async createStudent(
    connectionId: string,
    phone: string,
    planName: string | null,
    name = "",
    passwordHash = "",
  ) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const plan = planName
        ? await tx.query.plans.findFirst({ where: eq(plans.name, planName) })
        : undefined;
      let student = await tx.query.students.findFirst({
        where: and(eq(students.connectionId, connectionId), eq(students.phone, phone)),
      });
      if (!student) {
        const ends = plan?.durationDays
          ? new Date(now.getTime() + plan.durationDays * 86_400_000)
          : null;
        [student] = await tx
          .insert(students)
          .values({
            connectionId,
            phone,
            level: "B1",
            planId: plan?.id ?? null,
            planStartedAt: now,
            planEndsAt: ends,
          })
          .returning();
      }
      if (!student) throw new Error("student not created");
      const changes: Partial<StudentRow> = { verifiedAt: student.verifiedAt ?? now };
      if (name) changes.name = name;
      if (passwordHash) changes.passwordHash = passwordHash;
      [student] = await tx
        .update(students)
        .set(changes)
        .where(eq(students.id, student.id))
        .returning();
      if (!student) throw new Error("student not updated");
      const current = student.planId
        ? await tx.query.plans.findFirst({ where: eq(plans.id, student.planId) })
        : null;
      return toAccess(student, current ?? null);
    });
  }

  async advancePlan(userId: number) {
    const ended = await advanceEndedPlan(this.db, userId);
    if (!ended) return null;
    const [row] = await this.db
      .select({ student: students, plan: plans })
      .from(students)
      .leftJoin(plans, eq(plans.id, students.planId))
      .where(eq(students.id, userId))
      .limit(1);
    return row ? { access: toAccess(row.student, row.plan), ended } : null;
  }

  async setPassword(userId: number, passwordHash: string): Promise<void> {
    await this.db.update(students).set({ passwordHash }).where(eq(students.id, userId));
  }

  async phoneOf(userId: number): Promise<string | null> {
    const row = await this.db.query.students.findFirst({
      columns: { phone: true },
      where: eq(students.id, userId),
    });
    return row?.phone ?? null;
  }

  async saveTurn(userId: number, log: TurnLog): Promise<void> {
    const ev = log.evaluation;
    await this.db.transaction(async (tx) => {
      const prefs: Partial<Preferences> = log.prefs ?? {};
      const changes: Partial<StudentRow> = { topic: log.topic, level: log.level };
      if (prefs.level) changes.level = prefs.level;
      if (prefs.topic) changes.topic = prefs.topic;
      if (prefs.ui_lang) changes.uiLang = prefs.ui_lang;
      if (prefs.tutor) changes.tutor = prefs.tutor;
      if (prefs.speed !== null && prefs.speed !== undefined) changes.speed = prefs.speed;
      if (prefs.daily_goal) changes.dailyGoal = prefs.daily_goal;
      await tx
        .update(students)
        .set({ ...changes, lastMessageAt: sql`now()` })
        .where(eq(students.id, userId));
      const [turn] = await tx
        .insert(turns)
        .values({
          studentId: userId,
          kind: log.kind,
          topic: log.topic,
          level: log.level,
          transcript: log.transcript,
          evaluation: ev,
          score: ev?.score ?? null,
          replyText: log.reply_text,
          blockedReason: log.blocked_reason,
          costUsd: log.cost_usd,
          inputTokens: log.input_tokens,
          outputTokens: log.output_tokens,
          latencyMs: log.latency_ms,
          errors: log.errors.length ? log.errors : null,
          notes: log.notes.length ? log.notes : null,
        })
        .returning({ id: turns.id });
      const real = (ev?.mistakes ?? []).filter((m) => m.type !== "unclear"); // noise, not a mistake
      if (turn && real.length) {
        await tx.insert(mistakes).values(
          real.map((m) => ({
            studentId: userId,
            turnId: turn.id,
            original: m.original,
            correction: m.correction,
            type: m.type,
            explanation: m.explanation,
            topic: log.topic,
          })),
        );
      }
    });
  }

  async recentTurns(userId: number, sinceS: number, limit: number): Promise<PastTurn[]> {
    const rows = await this.db
      .select({
        student: turns.transcript,
        tutor: turns.replyText,
        topic: turns.topic,
        at: turns.createdAt,
      })
      .from(turns)
      .where(
        and(
          eq(turns.studentId, userId),
          gte(turns.createdAt, new Date(sinceS * 1000)),
          isNotNull(turns.replyText),
          ne(turns.kind, "blocked"),
        ),
      )
      .orderBy(desc(turns.id))
      .limit(limit);
    return rows.reverse().map((r) => ({
      student: r.student ?? "",
      tutor: r.tutor ?? "",
      topic: r.topic,
      at: r.at.getTime() / 1000,
    }));
  }

  async practiceStats(userId: number, since: Date, level: string, minScore: number) {
    const evaluated = and(eq(turns.studentId, userId), inArray(turns.kind, ["audio", "text"]));
    const [today] = await this.db
      .select({ n: count() })
      .from(turns)
      .where(and(evaluated, gte(turns.createdAt, since), isNotNull(turns.score)));
    const [good] = await this.db
      .select({ n: count() })
      .from(turns)
      .where(and(evaluated, eq(turns.level, level), gte(turns.score, minScore)));
    return { today: today?.n ?? 0, goodAtLevel: good?.n ?? 0 };
  }
}
