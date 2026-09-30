/** Read/write queries of the panel (Drizzle). Kept apart from the routes so they read like a
 * list of what the panel can do. */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  like,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { digits, variants } from "../accounts/phones.js";
import type { Db } from "../db/client.js";
import { advanceEndedPlan } from "../db/plan-changes.js";
import {
  adminUsers,
  auditLog,
  courseLessons,
  mistakes,
  plans,
  students,
  turns,
} from "../db/schema.js";
import { GOOD_SCORE, goalOf, type Practice, rankingName, weekPoints } from "../domain/progress.js";
import type { AdminUser, Student } from "./security.js";
import { isoDay, localMidnight, previousDay, safeZone, weekStart } from "./zones.js";

export const PAGE = 50;
export const EVALUATED = ["audio", "text"];
const DAY_MS = 24 * 3600 * 1000;

export type Plan = typeof plans.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;

export interface StudentRow {
  student: Student;
  plan: Plan | null;
  turns: number;
}

export interface DailyScore {
  day: string; // YYYY-MM-DD, local
  avg: number;
  n: number;
}

export interface TopMistake {
  original: string;
  correction: string;
  n: number;
}

export interface Progress {
  practices: number;
  audio: number;
  avgScore: number | null;
  avgScoreWeek: number | null;
  daysActive: number;
  streak: number; // days in a row with the daily goal met (today counts once met)
  today: number; // evaluated practices today
  goodAtLevel: number; // answers scoring GOOD_SCORE+ at the student's level
  daily: DailyScore[];
  topMistakes: TopMistake[];
  recent: Turn[];
}

export interface Dashboard {
  active: number;
  blocked: number;
  newWeek: number;
  turnsToday: number;
  avgToday: number | null;
  errorsToday: number;
  recent: { turn: Turn; student: Student }[];
}

export interface PlanValues {
  name: string;
  description: string;
  messagesPerDay: number | null;
  durationDays: number | null;
  isActive: boolean;
  tutors: string[] | null;
  speeds: number[] | null;
  nextPlanId: number | null;
  lessonsPerDay: number | null;
}

export interface RankRow {
  studentId: number;
  name: string; // "Maria S."
  points: number;
  practices: number;
}

/** Round to an integer; halves go to the even neighbour (averages of integer scores hit .5). */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const avgOrNull = (value: unknown) =>
  value === null || value === undefined ? null : roundHalfEven(Number(value));

export class PanelQueries {
  readonly tz: string;

  constructor(
    private readonly db: Db,
    tz = "America/Sao_Paulo",
  ) {
    this.tz = safeZone(tz);
  }

  /** Same queries, days counted in another zone (the configured timezone). */
  inZone(tz: string): PanelQueries {
    return safeZone(tz) === this.tz ? this : new PanelQueries(this.db, tz);
  }

  // --- audit ---------------------------------------------------------------------------------
  async audit(
    actor: string,
    action: string,
    target = "",
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.insert(auditLog).values({
      actor,
      action,
      target,
      details: Object.keys(details).length ? details : null,
    });
  }

  async auditLog(limit = 200): Promise<AuditEntry[]> {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  }

  // --- plans ---------------------------------------------------------------------------------
  async plans(onlyActive = false): Promise<Plan[]> {
    const query = this.db.select().from(plans);
    return (onlyActive ? query.where(eq(plans.isActive, true)) : query).orderBy(asc(plans.id));
  }

  async plan(planId: number): Promise<Plan | null> {
    return (await this.db.query.plans.findFirst({ where: eq(plans.id, planId) })) ?? null;
  }

  async planByName(name: string): Promise<Plan | null> {
    return (await this.db.query.plans.findFirst({ where: eq(plans.name, name) })) ?? null;
  }

  /** Update plan `planId` (or create one when it does not exist). Throws on a duplicate name. */
  async savePlan(planId: number | null, values: PlanValues): Promise<Plan> {
    if (planId) {
      const [updated] = await this.db
        .update(plans)
        .set(values)
        .where(eq(plans.id, planId))
        .returning();
      if (updated) return updated;
    }
    const [created] = await this.db.insert(plans).values(values).returning();
    if (!created) throw new Error("plan not created");
    return created;
  }

  // --- students ------------------------------------------------------------------------------
  async students(
    search = "",
    status = "",
    planId: number | null = null,
    page = 0,
  ): Promise<[StudentRow[], number]> {
    const conditions: SQL[] = [ne(students.connectionId, "eval")];
    if (search.trim()) {
      const term = `%${search.trim()}%`;
      const phone = digits(search);
      const found = [ilike(students.name, term)];
      if (phone) found.push(like(students.phone, `%${phone}%`));
      conditions.push(or(...found) as SQL);
    }
    if (status) conditions.push(eq(students.status, status));
    if (planId) conditions.push(eq(students.planId, planId));
    const where = and(...conditions);
    const [total] = await this.db.select({ n: count() }).from(students).where(where);
    const turnCounts = this.db
      .select({ studentId: turns.studentId, n: count().as("n") })
      .from(turns)
      .where(inArray(turns.kind, EVALUATED))
      .groupBy(turns.studentId)
      .as("turn_counts");
    const rows = await this.db
      .select({
        student: students,
        plan: plans,
        turns: sql<number>`coalesce(${turnCounts.n}, 0)`.mapWith(Number),
      })
      .from(students)
      .leftJoin(plans, eq(plans.id, students.planId))
      .leftJoin(turnCounts, eq(turnCounts.studentId, students.id))
      .where(where)
      .orderBy(sql`${students.lastMessageAt} desc nulls last`, desc(students.id))
      .limit(PAGE)
      .offset(page * PAGE);
    return [rows, total?.n ?? 0];
  }

  async student(studentId: number): Promise<StudentRow | null> {
    const [row] = await this.db
      .select({ student: students, plan: plans })
      .from(students)
      .leftJoin(plans, eq(plans.id, students.planId))
      .where(eq(students.id, studentId))
      .limit(1);
    return row ? { ...row, turns: 0 } : null;
  }

  /** A trial that ended becomes its next plan (the bot does the same on the next message). */
  async advancePlan(studentId: number): Promise<void> {
    await advanceEndedPlan(this.db, studentId);
  }

  async studentsByPhone(phone: string): Promise<Student[]> {
    return this.db
      .select()
      .from(students)
      .where(inArray(students.phone, variants(phone)));
  }

  async updateStudent(
    studentId: number,
    values: Partial<typeof students.$inferInsert>,
  ): Promise<void> {
    await this.db.update(students).set(values).where(eq(students.id, studentId));
  }

  async setPlan(studentId: number, plan: Plan | null, endsAt: Date | null): Promise<void> {
    const now = new Date();
    let ends = endsAt;
    if (plan && ends === null && plan.durationDays) {
      ends = new Date(now.getTime() + plan.durationDays * DAY_MS);
    }
    await this.updateStudent(studentId, {
      planId: plan ? plan.id : null,
      planStartedAt: now,
      planEndsAt: ends,
    });
  }

  async createStudent(
    connectionId: string,
    phone: string,
    values: Partial<typeof students.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await this.db
      .insert(students)
      .values({ connectionId, phone, level: "B1", ...values })
      .returning({ id: students.id });
    if (!row) throw new Error("student not created");
    return row.id;
  }

  async deleteStudent(studentId: number): Promise<void> {
    await this.db.delete(students).where(eq(students.id, studentId));
  }

  // --- numbers -------------------------------------------------------------------------------
  async dashboard(): Promise<Dashboard> {
    const today = localMidnight(this.tz);
    const real = ne(students.connectionId, "eval");
    const byStatus = new Map(
      (
        await this.db
          .select({ status: students.status, n: count() })
          .from(students)
          .where(real)
          .groupBy(students.status)
      ).map((r) => [r.status, r.n]),
    );
    const week = new Date(Date.now() - 7 * DAY_MS);
    const [fresh] = await this.db
      .select({ n: count() })
      .from(students)
      .where(and(real, gte(students.createdAt, week)));
    const [todayRow] = await this.db
      .select({
        n: count(),
        avg: sql<string | null>`avg(${turns.score})`,
        errors: sql<number>`count(*) filter (where ${turns.errors} is not null)`.mapWith(Number),
      })
      .from(turns)
      .innerJoin(students, eq(students.id, turns.studentId))
      .where(and(real, gte(turns.createdAt, today), inArray(turns.kind, EVALUATED)));
    const recent = await this.db
      .select({ turn: turns, student: students })
      .from(turns)
      .innerJoin(students, eq(students.id, turns.studentId))
      .where(real)
      .orderBy(desc(turns.id))
      .limit(15);
    return {
      active: byStatus.get("active") ?? 0,
      blocked: byStatus.get("blocked") ?? 0,
      newWeek: fresh?.n ?? 0,
      turnsToday: todayRow?.n ?? 0,
      avgToday: avgOrNull(todayRow?.avg),
      errorsToday: todayRow?.errors ?? 0,
      recent,
    };
  }

  /** `goal`: the student's daily goal (streak days); `level`: their level (the way up). */
  async progress(studentId: number, goal = 1, level = "", days = 30): Promise<Progress> {
    // the zone goes in as a literal (validated by safeZone): bound parameters would make each
    // use of the expression different and GROUP BY would refuse it
    const zone = sql.raw(`'${this.tz.replaceAll("'", "''")}'`);
    const localDay = sql`(timezone(${zone}, ${turns.createdAt}))::date`;
    const mine = and(eq(turns.studentId, studentId), inArray(turns.kind, EVALUATED));
    const since = new Date(Date.now() - days * DAY_MS);
    const week = new Date(Date.now() - 7 * DAY_MS);
    const [totals] = await this.db
      .select({
        n: count(),
        audio: sql<number>`count(*) filter (where ${turns.kind} = 'audio')`.mapWith(Number),
        avg: sql<string | null>`avg(${turns.score})`,
        avgWeek: sql<
          string | null
        >`avg(case when ${turns.createdAt} >= ${week.toISOString()} then ${turns.score} end)`,
        days: sql<number>`count(distinct ${localDay})`.mapWith(Number),
      })
      .from(turns)
      .where(mine);
    const daily = await this.db
      .select({
        day: sql<string>`${localDay}::text`,
        avg: sql<string>`avg(${turns.score})`,
        n: count(),
      })
      .from(turns)
      .where(and(mine, gte(turns.createdAt, since), sql`${turns.score} is not null`))
      .groupBy(localDay)
      .orderBy(localDay);
    const perDay = new Map(
      (
        await this.db
          .select({ day: sql<string>`${localDay}::text`, n: count() })
          .from(turns)
          .where(mine)
          .groupBy(localDay)
      ).map((r) => [r.day, r.n]),
    );
    // a finished lesson (/aula) is a practice too (daily goal, streak)
    const lessonDay = sql`(timezone(${zone}, ${courseLessons.finishedAt}))::date`;
    for (const r of await this.db
      .select({ day: sql<string>`${lessonDay}::text`, n: count() })
      .from(courseLessons)
      .where(and(eq(courseLessons.studentId, studentId), eq(courseLessons.status, "done")))
      .groupBy(lessonDay)) {
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.n);
    }
    const [good] = await this.db
      .select({ n: count() })
      .from(turns)
      .where(and(mine, eq(turns.level, level), gte(turns.score, GOOD_SCORE)));
    const lowered = sql`lower(${mistakes.original})`;
    const top = await this.db
      .select({ original: sql<string>`${lowered}`, correction: mistakes.correction, n: count() })
      .from(mistakes)
      .where(eq(mistakes.studentId, studentId))
      .groupBy(lowered, mistakes.correction)
      .orderBy(desc(count()), sql`max(${mistakes.id}) desc`)
      .limit(8);
    const recent = await this.db.select().from(turns).where(mine).orderBy(desc(turns.id)).limit(10);
    const met = (d: string) => (perDay.get(d) ?? 0) >= goalOf(goal);
    const today = isoDay(new Date(), this.tz);
    let streak = 0;
    let day = today;
    if (!met(day)) day = previousDay(day); // goal not met yet today: the streak is still alive
    while (met(day)) {
      streak += 1;
      day = previousDay(day);
    }
    return {
      practices: totals?.n ?? 0,
      audio: totals?.audio ?? 0,
      avgScore: avgOrNull(totals?.avg),
      avgScoreWeek: avgOrNull(totals?.avgWeek),
      daysActive: totals?.days ?? 0,
      streak,
      today: perDay.get(today) ?? 0,
      goodAtLevel: good?.n ?? 0,
      daily: daily.map((d) => ({ day: d.day, avg: roundHalfEven(Number(d.avg)), n: d.n })),
      topMistakes: top,
      recent,
    };
  }

  /** This week's ranking (Monday on, local): students who did not opt out, best first. */
  async ranking(now = new Date()): Promise<RankRow[]> {
    const zone = sql.raw(`'${this.tz.replaceAll("'", "''")}'`);
    const rows = await this.db
      .select({
        studentId: turns.studentId,
        name: students.name,
        goal: students.dailyGoal,
        day: sql<string>`((timezone(${zone}, ${turns.createdAt}))::date)::text`,
        score: turns.score,
        kind: turns.kind,
      })
      .from(turns)
      .innerJoin(students, eq(students.id, turns.studentId))
      .where(
        and(
          gte(turns.createdAt, weekStart(this.tz, now)),
          inArray(turns.kind, EVALUATED),
          sql`${turns.score} is not null`,
          eq(students.inRanking, true),
          eq(students.status, "active"),
          ne(students.connectionId, "eval"),
        ),
      )
      .orderBy(asc(turns.id));
    const byStudent = new Map<number, { name: string; goal: number; practices: Practice[] }>();
    for (const r of rows) {
      const entry = byStudent.get(r.studentId) ?? {
        name: rankingName(r.name, r.studentId),
        goal: r.goal,
        practices: [],
      };
      entry.practices.push({ day: r.day, score: r.score, audio: r.kind === "audio" });
      byStudent.set(r.studentId, entry);
    }
    const lessons = await this.db
      .select({
        studentId: courseLessons.studentId,
        name: students.name,
        goal: students.dailyGoal,
        day: sql<string>`((timezone(${zone}, ${courseLessons.finishedAt}))::date)::text`,
        points: courseLessons.points,
      })
      .from(courseLessons)
      .innerJoin(students, eq(students.id, courseLessons.studentId))
      .where(
        and(
          eq(courseLessons.status, "done"),
          gte(courseLessons.finishedAt, weekStart(this.tz, now)),
          eq(students.inRanking, true),
          eq(students.status, "active"),
          ne(students.connectionId, "eval"),
        ),
      )
      .orderBy(asc(courseLessons.id));
    for (const r of lessons) {
      const entry = byStudent.get(r.studentId) ?? {
        name: rankingName(r.name, r.studentId),
        goal: r.goal,
        practices: [],
      };
      entry.practices.push({ day: r.day, score: null, audio: false, points: r.points });
      byStudent.set(r.studentId, entry);
    }
    return [...byStudent]
      .map(([studentId, e]) => ({
        studentId,
        name: e.name,
        points: weekPoints(e.practices, e.goal),
        practices: e.practices.length,
      }))
      .sort((a, b) => b.points - a.points || a.studentId - b.studentId);
  }

  async recentTurns(studentId: number, limit = 20): Promise<Turn[]> {
    return this.db
      .select()
      .from(turns)
      .where(eq(turns.studentId, studentId))
      .orderBy(desc(turns.id))
      .limit(limit);
  }

  // --- panel users ---------------------------------------------------------------------------
  async admins(): Promise<AdminUser[]> {
    return this.db.select().from(adminUsers).orderBy(asc(adminUsers.id));
  }

  async admin(adminId: number): Promise<AdminUser | null> {
    return (
      (await this.db.query.adminUsers.findFirst({ where: eq(adminUsers.id, adminId) })) ?? null
    );
  }

  async createAdmin(email: string, name: string, role: string, passwordHash: string) {
    const [row] = await this.db
      .insert(adminUsers)
      .values({ email: email.toLowerCase(), name, role, passwordHash, mustChangePassword: true })
      .returning({ id: adminUsers.id });
    if (!row) throw new Error("user not created");
    return row.id;
  }

  async updateAdmin(adminId: number, values: Partial<typeof adminUsers.$inferInsert>) {
    await this.db.update(adminUsers).set(values).where(eq(adminUsers.id, adminId));
  }
}
