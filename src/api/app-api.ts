/**
 * /app/v1: the API of the app (Flutter: Android, iOS, web). Docs: docs/multicanal.md.
 *
 * The app is one more channel for the core: a message posted here goes through the same queue,
 * graph, lessons and limits as a WhatsApp message (connection "app", address = student id), and
 * what the bot answers comes back as events (GET /events, long-poll). Login is the panel's
 * (phone + password); the session is an opaque bearer token (only its hash is stored).
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { verifyPassword } from "../accounts/passwords.js";
import { fromForm, variants } from "../accounts/phones.js";
import { RuntimeConfigStore } from "../accounts/runtime-store.js";
import { SqlAppStore } from "../adapters/app/sql.js";
import { APP_CONNECTION } from "../adapters/channels/app.js";
import { SqlCourseRepository } from "../adapters/course/sql.js";
import { SqlRepository } from "../adapters/repo/sql.js";
import { plans, students } from "../db/schema.js";
import { uiLangOf } from "../domain/accounts.js";
import { commandForOption } from "../domain/choices.js";
import { IncomingMessage } from "../domain/messages.js";
import { goalOf, MAX_DAILY_GOAL } from "../domain/progress.js";
import { LEVELS } from "../domain/topics.js";
import { getLogger } from "../logging.js";
import { PanelQueries } from "../panel/queries.js";
import type { AppEvent, AppStore } from "../ports/app.js";
import type { AppState } from "./deps.js";
import { httpError } from "./errors.js";
import { messageJson } from "./webhooks.js";

const log = getLogger("coach.api.app");
export const EVENTS_WAIT_S = 25; // long-poll; nginx keeps the request open longer than this
const EVENTS_LIMIT = 50;
const POLL_MS = 800;
const LOGIN_TRIES = 10; // per IP and phone, every 15 minutes
const LOGIN_WINDOW_S = 15 * 60;
const TEXT_MAX = 1000;

type Env = { Variables: { student: number } };

const Login = z.object({ phone: z.string().max(30), password: z.string().max(200) });
const TextMessage = z.union([
  z.object({ text: z.string().trim().min(1).max(TEXT_MAX) }),
  z.object({ option: z.string().regex(/^[\w:-]{1,40}$/) }), // a tapped button: its option id
]);
const Settings = z
  .object({
    level: z.enum(LEVELS as unknown as [string, ...string[]]),
    daily_goal: z.number().int().min(1).max(MAX_DAILY_GOAL),
    ui_lang: z.enum(["en", "pt"]).nullable(), // null: automatic, by level
    reminders: z.boolean(),
  })
  .partial()
  .strict();

const eventJson = (e: AppEvent) => ({
  id: e.id,
  kind: e.kind,
  text: e.text,
  data: e.data,
  media: e.mediaId ? `/app/v1/media/${e.mediaId}` : null,
  at: e.createdAt.toISOString(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function appRouter(state: AppState, store?: AppStore): Hono<Env> {
  const app = new Hono<Env>();
  const database = state.db;
  if (!database) throw new Error("the app API needs Postgres");
  const db = database.db;
  const apps = store ?? new SqlAppStore(db);
  const repo = new SqlRepository(db);
  const runtime = new RuntimeConfigStore(db, state.cache);

  app.post("/auth/login", async (c) => {
    const body = Login.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return httpError(c, 422);
    const phone = fromForm(body.data.phone);
    const ip = c.req.header("x-real-ip") ?? "local";
    const tries = await state.cache.incr(`app:login:${ip}:${phone ?? ""}`, 1, LOGIN_WINDOW_S);
    if (tries > LOGIN_TRIES) return httpError(c, 429);
    const [student] = phone
      ? await db
          .select()
          .from(students)
          .where(inArray(students.phone, variants(phone)))
          .limit(1)
      : [];
    const ok =
      student?.status === "active" &&
      (await verifyPassword(body.data.password, student.passwordHash));
    if (!student || !ok) return httpError(c, 401);
    // the app is one more channel of this student (address: the student id)
    await repo.linkIdentity(student.id, APP_CONNECTION, String(student.id));
    const token = await apps.createToken(student.id);
    log.info("app_login", { user_id: student.id });
    return c.json({ token, student: { id: student.id, name: student.name } });
  });

  // Media: an unguessable id (random UUID) that only its owner gets, in their events, and that
  // goes after a week. No bearer token here: the web's audio player cannot send one.
  app.get("/media/:id{[0-9a-f-]{36}}", async (c) => {
    const media = await apps.media(c.req.param("id") ?? "");
    if (!media) return httpError(c, 404);
    return c.body(new Uint8Array(media.data), 200, {
      "content-type": media.mime,
      "cache-control": "private, max-age=604800",
    });
  });

  // everything below needs the bearer token
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = /^Bearer ([\w-]{20,100})$/.exec(auth)?.[1];
    const student = token ? await apps.tokenStudent(token) : null;
    if (!student) return httpError(c, 401);
    c.set("student", student);
    await next();
  });

  app.post("/auth/logout", async (c) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    await apps.revokeToken(token);
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const id = c.get("student");
    const [row] = await db
      .select({ student: students, plan: plans })
      .from(students)
      .leftJoin(plans, eq(plans.id, students.planId))
      .where(eq(students.id, id))
      .limit(1);
    if (!row) return httpError(c, 404);
    const config = await runtime.get();
    const s = row.student;
    const goal = goalOf(s.dailyGoal);
    const progress = await new PanelQueries(db, config.timezone).progress(id, goal, s.level);
    const course = await new SqlCourseRepository(db).stats(id, new Date());
    return c.json({
      id,
      name: s.name,
      level: s.level,
      ui_lang: uiLangOf(s.uiLang, s.level, config.default_ui_lang),
      ui_lang_chosen: s.uiLang,
      reminders: s.reminders,
      plan: row.plan
        ? { name: row.plan.name, messages_per_day: row.plan.messagesPerDay, ends_at: s.planEndsAt }
        : null,
      goal,
      today: progress.today,
      streak: progress.streak,
      practices: progress.practices,
      average_score: progress.avgScore,
      course,
    });
  });

  app.patch("/me/settings", async (c) => {
    const body = Settings.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return httpError(c, 422);
    const v = body.data;
    await db
      .update(students)
      .set({
        ...(v.level ? { level: v.level } : {}),
        ...(v.daily_goal ? { dailyGoal: v.daily_goal } : {}),
        ...(v.ui_lang !== undefined ? { uiLang: v.ui_lang } : {}),
        ...(v.reminders !== undefined ? { reminders: v.reminders } : {}),
      })
      .where(eq(students.id, c.get("student")));
    return c.json({ ok: true });
  });

  /** A text, a tapped option, or an audio recording (multipart field "audio"). */
  app.post("/messages", async (c) => {
    const id = c.get("student");
    const base = { id: `app-${randomUUID()}`, from: String(id), timestamp: new Date() };
    let msg: IncomingMessage;
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const declared = Number(c.req.header("content-length") || 0);
      if (declared > state.settings.maxAudioBytes + 64_000) return httpError(c, 413);
      const form = await c.req.formData().catch(() => null);
      const audio = form?.get("audio");
      if (!(audio instanceof File) || !audio.size) return httpError(c, 422);
      if (audio.size > state.settings.maxAudioBytes) return httpError(c, 413);
      const data = Buffer.from(await audio.arrayBuffer());
      const mediaId = await apps.putMedia(id, data, audio.type || "audio/webm");
      msg = IncomingMessage.parse({
        ...base,
        type: "audio",
        media_ref: mediaId,
        media_size: audio.size,
      });
    } else {
      const body = TextMessage.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return httpError(c, 422);
      const text =
        "text" in body.data
          ? body.data.text
          : (commandForOption(body.data.option) ?? body.data.option);
      msg = IncomingMessage.parse({ ...base, type: "text", text });
    }
    const eventId = await state.events.record(APP_CONNECTION, msg.id, { app: true });
    await state.queue.add("process_message", {
      connection_id: APP_CONNECTION,
      message: messageJson(msg),
      event_id: eventId,
      attempt: 0,
    });
    return c.json({ id: msg.id }, 202);
  });

  /** New events after `after`; waits up to `wait` seconds (25 at most) for the first one.
   * `recent=N`: the last N events instead (the history when the app opens). */
  app.get("/events", async (c) => {
    const id = c.get("student");
    const recent = Math.min(EVENTS_LIMIT, Number(c.req.query("recent") ?? 0) || 0);
    if (recent > 0) return c.json({ events: (await apps.recentEvents(id, recent)).map(eventJson) });
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const wait = Math.min(EVENTS_WAIT_S, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    const until = Date.now() + wait * 1000;
    let events = await apps.events(id, after, EVENTS_LIMIT);
    while (!events.length && Date.now() < until && !c.req.raw.signal.aborted) {
      await sleep(POLL_MS);
      events = await apps.events(id, after, EVENTS_LIMIT);
    }
    return c.json({ events: events.map(eventJson) });
  });

  return app;
}
