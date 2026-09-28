/** A plan that ended moves the student to its next plan (the 30-day trial becomes the free
 * plan). Run lazily wherever the plan matters: the WhatsApp gate and the panel. */
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { plans, students } from "./schema.js";

const DAY_MS = 24 * 3600 * 1000;
const MAX_HOPS = 5; // a loop of plans pointing at each other must not spin forever

/** The ended plan's name when the student moved on, else null. */
export async function advanceEndedPlan(
  db: Db,
  studentId: number,
  now = new Date(),
): Promise<string | null> {
  let ended: string | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const [row] = await db
      .select({ student: students, plan: plans })
      .from(students)
      .innerJoin(plans, eq(plans.id, students.planId))
      .where(eq(students.id, studentId))
      .limit(1);
    const ends = row?.student.planEndsAt;
    const nextId = row?.plan.nextPlanId;
    if (!row || !ends || ends.getTime() > now.getTime() || !nextId) return ended;
    const next = await db.query.plans.findFirst({ where: eq(plans.id, nextId) });
    if (!next) return ended;
    ended ??= row.plan.name;
    await db
      .update(students)
      .set({
        planId: next.id,
        planStartedAt: ends,
        planEndsAt: next.durationDays
          ? new Date(ends.getTime() + next.durationDays * DAY_MS)
          : null,
      })
      .where(eq(students.id, studentId));
  }
  return ended;
}
