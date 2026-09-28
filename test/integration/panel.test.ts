/** The web panel end to end: the Hono sub-app, real Postgres (database coach_test) and Redis
 * db 15. The bot side of the WhatsApp codes runs through the real AccountGate with a fake
 * channel. Requests go through `app.request()` with a small cookie jar (no server). */
import { Hono } from "hono";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccountGate } from "../../src/accounts/gate.js";
import { hashPassword } from "../../src/accounts/passwords.js";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import { RedisCache } from "../../src/adapters/cache/redis.js";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { SqlRepository } from "../../src/adapters/repo/sql.js";
import { loadSettings } from "../../src/config.js";
import { connect } from "../../src/db/client.js";
import { IncomingMessage } from "../../src/domain/messages.js";
import { createPanel } from "../../src/panel/index.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL, TRUNCATE } from "./helpers.js";

const CONN = "meta-main";
const WA_ID = "551187654321"; // how WhatsApp sends this Brazilian number: no ninth digit
const TYPED = "+55 (11) 98765-4321";

const database = connect(TEST_DATABASE_URL);
const cache = RedisCache.fromUrl(TEST_REDIS_URL);
const redis = new Redis(TEST_REDIS_URL);
const settings = loadSettings(
  {},
  {
    databaseUrl: TEST_DATABASE_URL,
    redisUrl: TEST_REDIS_URL,
    publicBaseUrl: "https://saybest.test",
    env: "test",
  },
);
const enabled = new Map([[CONN, true]]);
const app = new Hono().route(
  "/panel",
  createPanel({
    settings,
    cache,
    db: database.db,
    connections: {
      list: async () =>
        [...enabled].map(([id, on]) => ({ id, name: "Main", provider: "meta", enabled: on })),
      get: async (id) => (enabled.has(id) ? { id, enabled: enabled.get(id) ?? false } : null),
      setEnabled: async (id, on) => enabled.has(id) && Boolean(enabled.set(id, on)),
    },
    invalidateConnection: () => {},
  }),
);

afterAll(async () => {
  await cache.close();
  redis.disconnect();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query(TRUNCATE);
  await database.pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('whatsapp_number', '"5541999990000"')`,
  );
  await redis.flushdb();
});

interface Page {
  status: number;
  headers: Headers;
  text: string;
  location: string;
}

/** A browser-ish client: keeps cookies, follows 303s unless told not to. */
class Client {
  readonly cookies = new Map<string, string>();

  async request(
    method: string,
    path: string,
    data: Record<string, string> | null = null,
    follow = true,
  ): Promise<Page> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let body: string | undefined;
    if (data) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(data).toString();
    }
    const res = await app.request(`https://testserver${path}`, { method, headers, body });
    for (const line of res.headers.getSetCookie()) this.store(line);
    const page = {
      status: res.status,
      headers: res.headers,
      text: await res.text(),
      location: res.headers.get("location") ?? "",
    };
    if (follow && res.status === 303 && page.location) return this.get(page.location);
    return page;
  }

  private store(line: string): void {
    const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const gone = attrs.some(
      (a) =>
        /^max-age=0$/i.test(a) ||
        (/^expires=/i.test(a) && new Date(a.slice(8)).getTime() < Date.now()),
    );
    if (gone || !value) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  get(path: string, follow = true): Promise<Page> {
    return this.request("GET", path, null, follow);
  }

  post(path: string, data: Record<string, string>, follow = true): Promise<Page> {
    return this.request("POST", path, data, follow);
  }
}

async function csrf(c: Client, path: string): Promise<string> {
  const page = await c.get(path);
  expect(page.status, page.text).toBe(200);
  const match = /name="csrf" value="([^"]+)"/.exec(page.text);
  expect(match, "form without csrf").toBeTruthy();
  return match?.[1] ?? "";
}

/** What the WhatsApp side does with a code (the real gate, fake channel). */
async function botReceives(text: string, phone = WA_ID): Promise<FakeChannel> {
  const channel = new FakeChannel();
  const gate = new AccountGate(new SqlRepository(database.db), cache, "https://saybest.test/panel");
  const message = IncomingMessage.parse({
    id: "m1",
    from: phone,
    timestamp: new Date(),
    type: "text",
    text,
  });
  await gate.admit(message, CONN, channel, defaultRuntimeConfig());
  return channel;
}

async function signup(c: Client, name = "Ana"): Promise<[string, string]> {
  const token = await csrf(c, "/panel/signup");
  const form = {
    csrf: token,
    name,
    phone: TYPED,
    password: "segredo123",
    password2: "segredo123",
    lang: "pt",
  };
  const resp = await c.post("/panel/signup", form, false);
  expect(resp.status, resp.text).toBe(303);
  const match = /t=([^&]+)&c=(\d{6})/.exec(resp.location);
  expect(match).toBeTruthy();
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

async function makeAdmin(email: string, role = "admin"): Promise<void> {
  await database.pool.query(
    "INSERT INTO admin_users (email, name, password_hash, role, must_change_password) " +
      "VALUES ($1, 'Test', $2, $3, true)",
    [email, await hashPassword("temporaria-1"), role],
  );
}

async function adminLogin(c: Client, email: string): Promise<void> {
  const form = {
    csrf: await csrf(c, "/panel/admin/login"),
    email,
    password: "temporaria-1",
  };
  expect((await c.post("/panel/admin/login", form, false)).status).toBe(303);
  // first login: must change the password before anything else
  const first = await c.get("/panel/admin", false);
  expect(first.status).toBe(303);
  expect(first.location).toBe("/panel/admin/password");
  const change = {
    csrf: await csrf(c, "/panel/admin/password"),
    current: "temporaria-1",
    password: "definitiva-1",
    password2: "definitiva-1",
  };
  expect((await c.post("/panel/admin/password", change, false)).status).toBe(303);
}

describe("panel", () => {
  it("signup is confirmed from WhatsApp and logs in", async () => {
    const client = new Client();
    const [token, code] = await signup(client);
    const wait = await client.get(`/panel/signup/wait?t=${token}&c=${code}`);
    expect(wait.text).toContain(`ATIVAR ${code}`);
    expect(wait.text).toContain("wa.me/5541999990000");
    expect(wait.headers.get("refresh")).toBe("4");
    await botReceives(`ATIVAR ${code}`);
    const done = await client.get(`/panel/signup/wait?t=${token}&c=${code}`, false);
    expect(done.status).toBe(303);
    expect(done.location.startsWith("/panel/me")).toBe(true);
    const home = await client.get("/panel/me");
    expect(home.text).toContain("Olá, Ana");
    expect(home.text).toContain("Teste Ilimitado"); // 30 days, then the free plan
    expect(home.text).toContain("Meta de hoje");
    const again = await client.get(`/panel/signup/wait?t=${token}&c=${code}`, false);
    expect(again.status).toBe(200);
    expect(again.text).toContain("expirado"); // the link logs in once
  });

  it("forms refuse a phone without country code", async () => {
    const c = new Client();
    for (const [page, extra] of [
      ["/panel/signup", { name: "Ana", password: "segredo123", password2: "segredo123" }],
      ["/panel/login", { password: "segredo123" }],
      ["/panel/forgot", {}],
    ] as const) {
      const form = { csrf: await csrf(c, page), phone: "(11) 98765-4321", ...extra };
      const resp = await c.post(page, form, false);
      expect(resp.status, page).toBe(400);
      expect(resp.text, page).toContain("com DDI e DDD");
    }
  });

  it("a code from another number does not create the account", async () => {
    const client = new Client();
    const [token, code] = await signup(client);
    const channel = await botReceives(`ATIVAR ${code}`, "5511999990000");
    expect(channel.sent[0]?.text ?? "").toContain("outro número");
    const page = await client.get(`/panel/signup/wait?t=${token}&c=${code}`);
    expect(page.text).toContain("Número diferente");
  });

  it("login, password reset and throttle", async () => {
    let client = new Client();
    const [, code] = await signup(client);
    await botReceives(`ATIVAR ${code}`);
    client = new Client();
    const form = { csrf: await csrf(client, "/panel/login"), phone: TYPED, password: "errada123" };
    expect((await client.post("/panel/login", form)).status).toBe(401);
    form.password = "segredo123";
    const ok = await client.post("/panel/login", form, false);
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/panel/me");
    // reset: the code must come from the account's WhatsApp
    client = new Client();
    const forgot = { csrf: await csrf(client, "/panel/forgot"), phone: TYPED };
    const resp = await client.post("/panel/forgot", forgot, false);
    const match = /t=([^&]+)&c=(\d{6})/.exec(resp.location);
    expect(match).toBeTruthy();
    await botReceives(`SENHA ${match?.[2]}`);
    const page = await client.get(resp.location);
    expect(page.text).toContain("nova senha");
    const token = /name="csrf" value="([^"]+)"/.exec(page.text);
    expect(token).toBeTruthy();
    const fresh = {
      csrf: token?.[1] ?? "",
      token: match?.[1] ?? "",
      password: "outra-senha-1",
      password2: "outra-senha-1",
    };
    const done = await client.post("/panel/forgot/reset", fresh, false);
    expect(done.status).toBe(303);
    expect(done.location.startsWith("/panel/me")).toBe(true);
    client = new Client();
    const bad = { csrf: await csrf(client, "/panel/login"), phone: TYPED, password: "nope-nope" };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await client.post("/panel/login", bad)).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it("student settings reach the bot", async () => {
    const client = new Client();
    const [token, code] = await signup(client);
    await botReceives(`ATIVAR ${code}`);
    await client.get(`/panel/signup/wait?t=${token}&c=${code}`);
    const form = {
      csrf: await csrf(client, "/panel/me/settings"),
      name: "Ana",
      level: "B2",
      topic: "travel",
      custom_topic: "",
      tutor: "george",
      speed: "0.8",
      ui_lang: "pt",
      daily_goal: "12",
    };
    expect((await client.post("/panel/me/settings", form, false)).status).toBe(303);
    const access = await new SqlRepository(database.db).studentAccess(CONN, WA_ID);
    expect(access).not.toBeNull();
    expect([access?.level, access?.topic, access?.tutor, access?.speed, access?.ui_lang]).toEqual([
      "B2",
      "travel",
      "george",
      0.8,
      "pt",
    ]);
    expect(access?.daily_goal).toBe(12);
    // on the free plan, George and 0.8x are for paid plans
    await database.pool.query(
      "UPDATE students SET plan_id = (SELECT id FROM plans WHERE name = 'Grátis')",
    );
    const page = await client.get("/panel/me/settings");
    expect(page.text).toContain('value="george"  disabled');
    expect(page.text).toContain('<option value="sarah" selected'); // what plays now
    const locked = await client.post("/panel/me/settings", {
      ...form,
      csrf: await csrf(client, "/panel/me/settings"),
    });
    expect(locked.status).toBe(400);
    expect(locked.text).toContain("planos pagos");
  });

  it("an ended trial shows the free plan; the ranking of the week", async () => {
    const client = new Client();
    const [token, code] = await signup(client);
    await botReceives(`ATIVAR ${code}`);
    await client.get(`/panel/signup/wait?t=${token}&c=${code}`);
    await database.pool.query("UPDATE students SET plan_ends_at = now() - interval '1 day'");
    const home = await client.get("/panel/me");
    expect(home.text).toContain("Plano Grátis");
    expect(home.text).toContain("de 15 mensagens");
    const [me] = (await database.pool.query("SELECT id FROM students")).rows;
    const other = await database.pool.query(
      "INSERT INTO students (connection_id, phone, name) VALUES ($1, '5511', 'Bia Souza Lima') RETURNING id",
      [CONN],
    );
    const hidden = await database.pool.query(
      "INSERT INTO students (connection_id, phone, name, in_ranking) VALUES ($1, '5512', 'Caio', false) RETURNING id",
      [CONN],
    );
    const turn = (id: number, kind: string, score: number) =>
      database.pool.query(
        "INSERT INTO turns (student_id, kind, topic, level, score, cost_usd, input_tokens, output_tokens, latency_ms) VALUES ($1, $2, 't', 'B1', $3, 0, 0, 0, 0)",
        [id, kind, score],
      );
    await turn(me.id, "audio", 80); // 16
    await turn(other.rows[0].id, "text", 100); // 15
    await turn(other.rows[0].id, "text", 90); // 14
    await turn(hidden.rows[0].id, "audio", 100);
    await turn(me.id, "blocked", 0);
    const ranking = (await client.get("/panel/me/ranking")).text;
    expect(ranking).toContain("Bia L.");
    expect(ranking).not.toContain("Caio");
    expect(ranking).toContain("29<small>pts</small>");
    expect(ranking).toContain("Ana");
    expect(ranking.indexOf("Bia L.")).toBeLessThan(ranking.indexOf("(você)"));
    expect((await client.get("/panel/me")).text).toContain("2º");
  });

  it("admin manages students, plans, settings and users", async () => {
    const client = new Client();
    await makeAdmin("boss@saybest.test");
    await adminLogin(client, "boss@saybest.test");
    const page = await client.get("/panel/admin");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Painel");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const token = await csrf(client, "/panel/admin/students/new");
    const created = await client.post(
      "/panel/admin/students/new",
      { csrf: token, name: "Bruno", phone: "+55 11 91234-5678", plan_id: "2", connection: CONN },
      false,
    );
    expect(created.status).toBe(303);
    const studentUrl = created.location.split("?")[0] ?? "";
    expect((await client.get("/panel/admin/students?q=bru")).text).toContain("Bruno");
    const save = await client.post(
      studentUrl,
      {
        csrf: token,
        name: "Bruno",
        status: "blocked",
        plan_id: "3",
        plan_ends_at: "",
        level: "A2",
        notes: "pagou",
      },
      false,
    );
    expect(save.status).toBe(303);
    expect((await client.get(studentUrl)).text).toContain("bloqueado");
    const plan = {
      csrf: token,
      name: "Pro",
      description: "",
      messages_per_day: "0",
      is_active: "on",
    };
    await database.pool.query("DELETE FROM plans WHERE name = 'Pro'"); // plans are not truncated
    const zero = await client.post("/panel/admin/plans", plan);
    expect(zero.status).toBe(400); // 0 would block everything while showing "ilimitado"
    const pro = await client.post(
      "/panel/admin/plans",
      { ...plan, messages_per_day: "100", tutor_emma: "on", speed_100: "on", speed_90: "on" },
      false,
    );
    expect(pro.status).toBe(303);
    const [row] = (await database.pool.query("SELECT tutors, speeds FROM plans WHERE name = 'Pro'"))
      .rows;
    expect([row.tutors, row.speeds]).toEqual([["emma"], [1, 0.9]]);
    const saved = await client.post(
      "/panel/admin/settings",
      {
        csrf: token,
        unknown_numbers: "trial",
        signup_enabled: "on",
        trial_plan: "Grátis",
        whatsapp_number: "5541999990000",
        signup_connection: CONN,
        contact_text: "",
        rate_limit_per_minute: "",
        session_idle_hours: "12",
        default_ui_lang: "pt",
        default_tutor: "sarah",
        timezone: "America/Sao_Paulo",
      },
      false,
    );
    expect(saved.status).toBe(303);
    const bad = await client.post("/panel/admin/settings", {
      csrf: token,
      session_idle_hours: "abc",
    });
    expect(bad.status).toBe(400);
    const staff = { csrf: token, name: "Equipe", email: "team@saybest.test", role: "staff" };
    const users = await client.post("/panel/admin/users", staff);
    expect(users.text).toContain("Senha provisória");
    const audit = (await client.get("/panel/admin/audit")).text;
    for (const action of ["create_student", "update_student", "save_settings", "create_user"]) {
      expect(audit).toContain(action);
    }
    // no CSRF token: refused
    expect((await client.post(studentUrl, { name: "x" })).status).toBe(403);
  });

  it("staff cannot reach admin pages", async () => {
    const client = new Client();
    await makeAdmin("staff@saybest.test", "staff");
    await adminLogin(client, "staff@saybest.test");
    expect((await client.get("/panel/admin/students")).status).toBe(200);
    for (const path of [
      "/panel/admin/settings",
      "/panel/admin/users",
      "/panel/admin/audit",
      "/panel/admin/connections",
    ]) {
      expect((await client.get(path)).status, path).toBe(403);
    }
  });

  it("pages need a login", async () => {
    const client = new Client();
    for (const [path, login] of [
      ["/panel/me", "/panel/login"],
      ["/panel/admin", "/panel/admin/login"],
    ] as const) {
      const resp = await client.get(path, false);
      expect(resp.status).toBe(303);
      expect(resp.location).toBe(login);
    }
  });
});
