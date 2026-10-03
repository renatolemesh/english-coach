/** In-memory TurnRepository for tests and simulate. Every number is a known, unlimited student
 * unless a test adds it to `access` (or sets `known = false` to try unknown numbers). Plans a
 * test puts in `plans` are applied by createStudent and advancePlan. */
import { type StudentAccess, StudentAccess as StudentAccessSchema } from "../../domain/accounts.js";
import type {
  PastTurn,
  ReminderCandidate,
  TurnLog,
  TurnRepository,
} from "../../ports/repository.js";

export interface MemoryPlan {
  messages_per_day?: number | null;
  lessons_per_day?: number | null;
  duration_days?: number | null;
  tutors?: string[] | null;
  speeds?: number[] | null;
  next?: string | null; // name of the next plan
}

export class MemoryRepository implements TurnRepository {
  readonly plans = new Map<string, MemoryPlan>();
  readonly students = new Map<string, number>(); // "connection|address" -> id (identities)
  readonly turns: [number, TurnLog][] = [];
  readonly turnTimes: number[] = []; // epoch seconds, parallel to `turns`
  readonly access = new Map<number, StudentAccess>();
  readonly passwords = new Map<number, string>();
  readonly lastMessage = new Map<number, Date>();
  readonly lastChannel = new Map<number, [string, string]>();
  readonly reminded = new Map<number, Date>();
  known = true;

  async getOrCreateStudent(connectionId: string, phone: string): Promise<number> {
    const key = `${connectionId}|${phone}`;
    if (!this.students.has(key)) this.students.set(key, new Set(this.students.values()).size + 1);
    return this.students.get(key) as number;
  }

  async studentAccess(connectionId: string, phone: string): Promise<StudentAccess | null> {
    if (!this.students.has(`${connectionId}|${phone}`) && !this.known) return null;
    const userId = await this.getOrCreateStudent(connectionId, phone);
    if (!this.access.has(userId))
      this.access.set(userId, StudentAccessSchema.parse({ user_id: userId }));
    return this.access.get(userId) as StudentAccess;
  }

  async createStudent(
    connectionId: string,
    phone: string,
    planName: string | null,
    name = "",
    passwordHash = "",
    uiLang: string | null = null,
  ) {
    const userId = await this.getOrCreateStudent(connectionId, phone);
    const access = StudentAccessSchema.parse({
      user_id: userId,
      name: name || null,
      ui_lang: uiLang ?? this.access.get(userId)?.ui_lang ?? null,
      ...this.planFields(planName, new Date()),
    });
    this.access.set(userId, access);
    if (passwordHash) this.passwords.set(userId, passwordHash);
    return access;
  }

  private planFields(planName: string | null, start: Date) {
    const plan = planName ? this.plans.get(planName) : undefined;
    const days = plan?.duration_days;
    return {
      plan_name: planName,
      messages_per_day: plan?.messages_per_day ?? null,
      lessons_per_day: plan?.lessons_per_day ?? null,
      tutors: plan?.tutors ?? null,
      speeds: plan?.speeds ?? null,
      plan_ends_at: days ? new Date(start.getTime() + days * 86_400_000) : null,
    };
  }

  async advancePlan(userId: number) {
    const current = this.access.get(userId);
    const ends = current?.plan_ends_at;
    const next = current?.plan_name ? this.plans.get(current.plan_name)?.next : null;
    if (!current || !ends || ends.getTime() > Date.now() || !next) return null;
    const access = { ...current, ...this.planFields(next, ends) };
    this.access.set(userId, access);
    return { access, ended: current.plan_name as string };
  }

  async setPassword(userId: number, passwordHash: string): Promise<void> {
    this.passwords.set(userId, passwordHash);
  }

  async phoneOf(userId: number): Promise<string | null> {
    for (const [key, id] of this.students) if (id === userId) return key.split("|")[1] ?? null;
    return null;
  }

  async saveTurn(userId: number, log: TurnLog): Promise<void> {
    this.turns.push([userId, log]);
    this.turnTimes.push(Date.now() / 1000);
    const current = this.access.get(userId);
    if (log.prefs && current) {
      const prefs = Object.fromEntries(Object.entries(log.prefs).filter(([, v]) => v !== null));
      this.access.set(userId, { ...current, ...prefs });
    }
  }

  async recentTurns(userId: number, sinceS: number, limit: number): Promise<PastTurn[]> {
    return this.turns
      .map(([id, log], i) => ({ id, log, at: this.turnTimes[i] ?? 0 }))
      .filter(
        ({ id, log, at }) =>
          id === userId && at >= sinceS && log.reply_text && log.kind !== "blocked",
      )
      .slice(-limit)
      .map(({ log, at }) => ({
        student: log.transcript ?? "",
        tutor: log.reply_text ?? "",
        topic: log.topic,
        at,
      }));
  }

  async practiceStats(userId: number, since: Date, level: string, minScore: number) {
    let today = 0;
    let goodAtLevel = 0;
    this.turns.forEach(([id, log], i) => {
      const score = log.evaluation?.score;
      if (id !== userId || !["audio", "text"].includes(log.kind) || score === undefined) return;
      if ((this.turnTimes[i] ?? 0) * 1000 >= since.getTime()) today += 1;
      if (log.level === level && score >= minScore) goodAtLevel += 1;
    });
    return { today, goodAtLevel };
  }

  async touch(userId: number, at: Date, connectionId: string, address: string): Promise<void> {
    this.lastMessage.set(userId, at);
    this.lastChannel.set(userId, [connectionId, address]);
  }

  async studentIdByPhone(phone: string): Promise<number | null> {
    for (const [key, id] of this.students) if (key.split("|")[1] === phone) return id;
    return null;
  }

  async linkIdentity(userId: number, connectionId: string, address: string): Promise<boolean> {
    const key = `${connectionId}|${address}`;
    const taken = this.students.get(key);
    if (taken !== undefined) return taken === userId;
    this.students.set(key, userId);
    return true;
  }

  async reminderCandidates(from: Date, to: Date): Promise<ReminderCandidate[]> {
    const out: ReminderCandidate[] = [];
    const seen = new Set<number>();
    for (const [key, userId] of this.students) {
      if (seen.has(userId)) continue; // one student, several channels
      seen.add(userId);
      const last = this.lastMessage.get(userId);
      const access = this.access.get(userId);
      const reminded = this.reminded.get(userId);
      if (!last || !access || access.status !== "active" || !access.reminders) continue;
      if (last < from || last >= to || (reminded && reminded >= last)) continue;
      const [connectionId = "", phone = ""] = this.lastChannel.get(userId) ?? key.split("|");
      out.push({ access, connectionId, phone });
    }
    return out;
  }

  async markReminded(userId: number, at: Date): Promise<void> {
    this.reminded.set(userId, at);
  }
}
