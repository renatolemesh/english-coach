// The app's API (/app/v1) on Postgres (coach_test): login, profile, messages, events, media.
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/accounts/passwords.js";
import { SqlAppStore } from "../../src/adapters/app/sql.js";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { SqlRepository } from "../../src/adapters/repo/sql.js";
import { appRouter } from "../../src/api/app-api.js";
import type { AppState } from "../../src/api/deps.js";
import { loadSettings } from "../../src/config.js";
import { EventLog } from "../../src/connections/events.js";
import { connect } from "../../src/db/client.js";
import { MemoryTaskQueue, type ProcessMessageJob } from "../../src/worker/queue.js";
import { TEST_DATABASE_URL, TRUNCATE } from "./helpers.js";

const database = connect(TEST_DATABASE_URL);
const store = new SqlAppStore(database.db);
const queue = new MemoryTaskQueue();
const state = {
  settings: loadSettings({}, { databaseUrl: TEST_DATABASE_URL, env: "test" }),
  cache: new MemoryCache(),
  events: new EventLog(database.db),
  queue,
  db: database,
} as unknown as AppState;
const api = new Hono().route("/app/v1", appRouter(state, store));
afterAll(() => database.close());

let studentId: number;
beforeEach(async () => {
  await database.pool.query(
    `${TRUNCATE.replace(" RESTART", ", app_events, app_media, app_tokens RESTART")}`,
  );
  queue.jobs.length = 0;
  const repo = new SqlRepository(database.db);
  studentId = (await repo.createStudent("meta-main", "5511987654321", "Ilimitado", "Ana")).user_id;
  await database.pool.query("UPDATE students SET password_hash = $1 WHERE id = $2", [
    await hashPassword("secret123"),
    studentId,
  ]);
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  return api.request(`/app/v1${path}`, { ...init, headers });
};
const login = async (password = "secret123") =>
  call("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: "+55 11 98765-4321", password }),
  });

describe("app API", () => {
  it("logs in with the panel's phone and password; the app becomes one of the student's channels", async () => {
    expect((await login("wrong-one")).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(200);
    const { token, student } = await res.json();
    expect(student).toEqual({ id: studentId, name: "Ana" });
    const access = await new SqlRepository(database.db).studentAccess("app", String(studentId));
    expect(access?.user_id).toBe(studentId);
    const me = await (await call("/me", { token })).json();
    expect([me.name, me.level, me.goal, me.today, me.plan.name]).toEqual([
      "Ana",
      "B1",
      5,
      0,
      "Ilimitado",
    ]);
    expect((await call("/me")).status).toBe(401); // no token
    await call("/auth/logout", { method: "POST", token });
    expect((await call("/me", { token })).status).toBe(401);
  });

  it("settings: level, goal, language (null: automatic) and reminders", async () => {
    const { token } = await (await login()).json();
    const body = JSON.stringify({ level: "A2", daily_goal: 8, ui_lang: null, reminders: false });
    expect((await call("/me/settings", { method: "PATCH", token, body })).status).toBe(200);
    const me = await (await call("/me", { token })).json();
    expect([me.level, me.goal, me.ui_lang, me.reminders]).toEqual(["A2", 8, "pt", false]);
    const bad = JSON.stringify({ level: "Z9" });
    expect((await call("/me/settings", { method: "PATCH", token, body: bad })).status).toBe(422);
  });

  it("messages go to the same queue as WhatsApp's: text, a tapped option, audio", async () => {
    const { token } = await (await login()).json();
    await call("/messages", {
      method: "POST",
      token,
      body: JSON.stringify({ text: "I goed home" }),
    });
    await call("/messages", { method: "POST", token, body: JSON.stringify({ option: "tema:2" }) });
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "a.webm");
    const audio = await call("/messages", { method: "POST", token, body: form });
    expect(audio.status).toBe(202);
    const jobs = queue.jobs.map((j) => j.data as ProcessMessageJob);
    expect(jobs.map((j) => j.connection_id)).toEqual(["app", "app", "app"]);
    expect(jobs.map((j) => j.message.text)).toEqual(["I goed home", "/tema 2", null]);
    expect(jobs.every((j) => j.message.from === String(studentId))).toBe(true);
    const media = await store.media(String(jobs[2]?.message.media_ref));
    expect([media?.mime, media?.data.length]).toEqual(["audio/webm", 3]);
  });

  it("events: what the bot sent, after a cursor; media only for its owner", async () => {
    const { token } = await (await login()).json();
    const voice = await store.putMedia(studentId, Buffer.from("ID3..."), "audio/mpeg");
    const first = await store.addEvent(studentId, {
      kind: "text",
      text: "Hi!",
      data: null,
      mediaId: null,
    });
    await store.addEvent(studentId, { kind: "voice", text: null, data: null, mediaId: voice });
    const { events } = await (await call("/events?after=0", { token })).json();
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["text", "voice"]);
    const later = await (await call(`/events?after=${first}`, { token })).json();
    expect(later.events).toHaveLength(1);
    const file = await call(later.events[0].media.replace("/app/v1", ""), { token });
    expect([file.status, file.headers.get("content-type")]).toEqual([200, "audio/mpeg"]);
    // someone else's token cannot read it
    const other = await new SqlRepository(database.db).createStudent(
      "meta-main",
      "5511900000000",
      null,
    );
    const otherToken = await store.createToken(other.user_id);
    expect(
      (await call(later.events[0].media.replace("/app/v1", ""), { token: otherToken })).status,
    ).toBe(404);
  });
});
