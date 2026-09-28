/**
 * Panel sessions, CSRF and login throttling.
 *
 * - The cookie holds a random token; the table `web_sessions` stores only its SHA-256, so a
 *   database leak gives no usable session. HttpOnly, SameSite=Lax, Secure behind HTTPS, path
 *   /panel. Admin sessions last ADMIN_TTL (and ADMIN_IDLE without use), students STUDENT_TTL.
 * - CSRF: every POST form carries the session's `csrf` value; forms shown before login use a
 *   double-submit cookie (PRE_CSRF_COOKIE) instead.
 * - Throttling (shared cache): failed logins per IP and per identifier, signups per IP.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { and, eq, lte } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client.js";
import { adminUsers, students, webSessions } from "../db/schema.js";
import type { Cache } from "../ports/cache.js";

export const COOKIE = "sb_session";
export const PRE_CSRF_COOKIE = "sb_csrf";
export const PATH = "/panel";
const HOUR_MS = 3600 * 1000;
export const ADMIN_TTL_MS = 12 * HOUR_MS;
export const ADMIN_IDLE_MS = 2 * HOUR_MS;
export const STUDENT_TTL_MS = 30 * 24 * HOUR_MS;
export const TOUCH_EVERY_MS = 5 * 60 * 1000;
export const MAX_FAILS_PER_ID = 5; // per THROTTLE_S
export const MAX_FAILS_PER_IP = 20;
export const MAX_SIGNUPS_PER_IP = 5; // per hour
export const THROTTLE_S = 15 * 60;
export type Kind = "admin" | "student";
export type AdminUser = typeof adminUsers.$inferSelect;
export type Student = typeof students.$inferSelect;

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** n random bytes as unpadded base64url text. */
export function tokenUrlsafe(nbytes: number): string {
  return randomBytes(nbytes).toString("base64url");
}

/** nginx sets X-Real-IP; the API is reachable only through nginx or 127.0.0.1. */
export function clientIp(c: Context): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return (c.req.header("x-real-ip") || incoming?.socket?.remoteAddress || "").slice(0, 64);
}

export function secureCookies(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return proto === "https";
}

export class Session {
  admin: AdminUser | null = null;
  student: Student | null = null;

  constructor(
    readonly id: string,
    readonly kind: Kind,
    readonly csrf: string,
  ) {}

  get isAdmin(): boolean {
    return this.admin !== null && this.admin.role === "admin";
  }

  get actor(): string {
    if (this.admin) return `${this.admin.role}:${this.admin.email}`;
    return `student:${this.student ? this.student.id : "?"}`;
  }
}

export class Sessions {
  constructor(private readonly db: Db) {}

  async create(c: Context, kind: Kind, subject: number): Promise<void> {
    const token = tokenUrlsafe(32);
    const ttl = kind === "admin" ? ADMIN_TTL_MS : STUDENT_TTL_MS;
    await this.db.insert(webSessions).values({
      id: sha256(token),
      kind,
      subjectId: subject,
      csrf: tokenUrlsafe(24),
      ip: clientIp(c),
      userAgent: (c.req.header("user-agent") ?? "").slice(0, 200),
      expiresAt: new Date(Date.now() + ttl),
    });
    setCookie(c, COOKIE, token, {
      maxAge: Math.floor(ttl / 1000),
      path: PATH,
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies(c),
    });
  }

  async load(c: Context): Promise<Session | null> {
    const token = getCookie(c, COOKIE);
    if (!token) return null;
    const now = Date.now();
    const row = await this.db.query.webSessions.findFirst({
      where: eq(webSessions.id, sha256(token)),
    });
    if (!row || row.expiresAt.getTime() <= now) return null;
    const idle = now - row.lastSeenAt.getTime();
    if (row.kind === "admin" && idle > ADMIN_IDLE_MS) {
      await this.db.delete(webSessions).where(eq(webSessions.id, row.id));
      return null;
    }
    if (idle > TOUCH_EVERY_MS) {
      await this.db
        .update(webSessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(webSessions.id, row.id));
    }
    const kind: Kind = row.kind === "admin" ? "admin" : "student";
    const session = new Session(row.id, kind, row.csrf);
    if (kind === "admin") {
      const admin = await this.db.query.adminUsers.findFirst({
        where: eq(adminUsers.id, row.subjectId),
      });
      if (!admin?.isActive) return null;
      session.admin = admin;
    } else {
      const student = await this.db.query.students.findFirst({
        where: eq(students.id, row.subjectId),
      });
      if (!student || student.status === "blocked") return null;
      session.student = student;
    }
    return session;
  }

  async destroy(c: Context, session: Session | null): Promise<void> {
    if (session) await this.db.delete(webSessions).where(eq(webSessions.id, session.id));
    deleteCookie(c, COOKIE, { path: PATH });
  }

  /** After a password change or block: every other login of that person ends. */
  async endAll(kind: Kind, subject: number): Promise<void> {
    await this.db
      .delete(webSessions)
      .where(and(eq(webSessions.kind, kind), eq(webSessions.subjectId, subject)));
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(webSessions).where(lte(webSessions.expiresAt, new Date()));
  }

  async touchLogin(adminId: number): Promise<void> {
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, adminId));
  }

  async adminByEmail(email: string): Promise<AdminUser | null> {
    const row = await this.db.query.adminUsers.findFirst({
      where: eq(adminUsers.email, email.toLowerCase()),
    });
    return row ?? null;
  }
}

export function checkCsrf(expected: string | null | undefined, given: string | null | undefined) {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token for forms shown before login (double-submit cookie, see setPreCsrf). */
export function preCsrfToken(c: Context): string {
  return getCookie(c, PRE_CSRF_COOKIE) || tokenUrlsafe(24);
}

export function setPreCsrf(c: Context, token: string): void {
  setCookie(c, PRE_CSRF_COOKIE, token, {
    path: PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure: secureCookies(c),
    maxAge: 3600,
  });
}

const count = (raw: Buffer | null) => (raw === null ? null : Number(raw.toString()));

export class Throttle {
  constructor(private readonly cache: Cache) {}

  async blocked(ip: string, identifier: string): Promise<boolean> {
    const byIp = count(await this.cache.get(`login:fail:ip:${ip}`));
    const byId = count(await this.cache.get(`login:fail:id:${identifier}`));
    return (
      (byIp !== null && byIp >= MAX_FAILS_PER_IP) || (byId !== null && byId >= MAX_FAILS_PER_ID)
    );
  }

  async failed(ip: string, identifier: string): Promise<void> {
    await this.cache.incr(`login:fail:ip:${ip}`, 1, THROTTLE_S);
    await this.cache.incr(`login:fail:id:${identifier}`, 1, THROTTLE_S);
  }

  async succeeded(identifier: string): Promise<void> {
    await this.cache.delete(`login:fail:id:${identifier}`);
  }

  async signupAllowed(ip: string): Promise<boolean> {
    const n = await this.cache.incr(`signup:ip:${ip}`, 1, 3600);
    return n <= MAX_SIGNUPS_PER_IP;
  }
}
