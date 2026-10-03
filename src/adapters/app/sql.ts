/** AppStore on Postgres (app_tokens, app_events, app_media). */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appEvents, appMedia, appTokens } from "../../db/schema.js";
import type { AppEvent, AppEventKind, AppMedia, AppStore } from "../../ports/app.js";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const TOUCH_EVERY_MS = 3600_000; // last_used_at, at most hourly (it is only for cleanup)

const toEvent = (r: typeof appEvents.$inferSelect): AppEvent => ({
  id: r.id,
  kind: r.kind as AppEventKind,
  text: r.text,
  data: r.data,
  mediaId: r.mediaId,
  createdAt: r.createdAt,
});

export class SqlAppStore implements AppStore {
  constructor(private readonly db: Db) {}

  async addEvent(studentId: number, e: Omit<AppEvent, "id" | "createdAt">): Promise<number> {
    const [row] = await this.db
      .insert(appEvents)
      .values({ studentId, kind: e.kind, text: e.text, data: e.data, mediaId: e.mediaId })
      .returning({ id: appEvents.id });
    if (!row) throw new Error("app event not stored");
    return row.id;
  }

  async recentEvents(studentId: number, limit: number): Promise<AppEvent[]> {
    const rows = await this.db
      .select()
      .from(appEvents)
      .where(eq(appEvents.studentId, studentId))
      .orderBy(desc(appEvents.id))
      .limit(limit);
    return rows.reverse().map(toEvent);
  }

  async events(studentId: number, afterId: number, limit: number): Promise<AppEvent[]> {
    const rows = await this.db
      .select()
      .from(appEvents)
      .where(and(eq(appEvents.studentId, studentId), gt(appEvents.id, afterId)))
      .orderBy(asc(appEvents.id))
      .limit(limit);
    return rows.map(toEvent);
  }

  async putMedia(studentId: number, data: Buffer, mime: string): Promise<string> {
    const id = randomUUID();
    await this.db.insert(appMedia).values({ id, studentId, data, mime });
    return id;
  }

  async media(id: string): Promise<AppMedia | null> {
    const row = await this.db.query.appMedia.findFirst({ where: eq(appMedia.id, id) });
    return row ? { studentId: row.studentId, mime: row.mime, data: Buffer.from(row.data) } : null;
  }

  async purgeMedia(before: Date): Promise<number> {
    const rows = await this.db
      .delete(appMedia)
      .where(lt(appMedia.createdAt, before))
      .returning({ id: appMedia.id });
    return rows.length;
  }

  async createToken(studentId: number): Promise<string> {
    const token = newToken();
    await this.db.insert(appTokens).values({ studentId, tokenHash: tokenHash(token) });
    return token;
  }

  async tokenStudent(token: string): Promise<number | null> {
    const row = await this.db.query.appTokens.findFirst({
      where: eq(appTokens.tokenHash, tokenHash(token)),
    });
    if (!row) return null;
    if (Date.now() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await this.db
        .update(appTokens)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(appTokens.id, row.id));
    }
    return row.studentId;
  }

  async revokeToken(token: string): Promise<void> {
    await this.db.delete(appTokens).where(eq(appTokens.tokenHash, tokenHash(token)));
  }
}
