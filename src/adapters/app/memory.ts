/** In-memory AppStore (tests, simulate). */
import { randomUUID } from "node:crypto";
import type { AppEvent, AppMedia, AppStore } from "../../ports/app.js";
import { newToken } from "./sql.js";

export class MemoryAppStore implements AppStore {
  readonly eventsByStudent = new Map<number, AppEvent[]>();
  readonly stored = new Map<string, AppMedia & { at: Date }>();
  readonly tokens = new Map<string, number>();
  private nextId = 1;

  async addEvent(studentId: number, e: Omit<AppEvent, "id" | "createdAt">): Promise<number> {
    const id = this.nextId++;
    const list = this.eventsByStudent.get(studentId) ?? [];
    list.push({ ...e, id, createdAt: new Date() });
    this.eventsByStudent.set(studentId, list);
    return id;
  }

  async recentEvents(studentId: number, limit: number): Promise<AppEvent[]> {
    return (this.eventsByStudent.get(studentId) ?? []).slice(-limit);
  }

  async events(studentId: number, afterId: number, limit: number): Promise<AppEvent[]> {
    return (this.eventsByStudent.get(studentId) ?? [])
      .filter((e) => e.id > afterId)
      .slice(0, limit);
  }

  async putMedia(studentId: number, data: Buffer, mime: string): Promise<string> {
    const id = randomUUID();
    this.stored.set(id, { studentId, data, mime, at: new Date() });
    return id;
  }

  async media(id: string): Promise<AppMedia | null> {
    const m = this.stored.get(id);
    return m ? { studentId: m.studentId, data: m.data, mime: m.mime } : null;
  }

  async purgeMedia(before: Date): Promise<number> {
    let n = 0;
    for (const [id, m] of this.stored) if (m.at < before && this.stored.delete(id)) n++;
    return n;
  }

  async createToken(studentId: number): Promise<string> {
    const token = newToken();
    this.tokens.set(token, studentId);
    return token;
  }

  async tokenStudent(token: string): Promise<number | null> {
    return this.tokens.get(token) ?? null;
  }

  async revokeToken(token: string): Promise<void> {
    this.tokens.delete(token);
  }
}
