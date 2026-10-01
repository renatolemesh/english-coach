import { describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import { PROJECT_ROOT } from "../../src/config.js";
import { DAILY_GOALS, MAX_PRACTICES_A_DAY, POINTS } from "../../src/domain/progress.js";
import { SETTINGS_FIELDS, STATUSES } from "../../src/panel/admin-routes.js";
import { newPasswordError, quote } from "../../src/panel/auth-routes.js";
import type { Plan, Progress, Turn } from "../../src/panel/queries.js";
import { type AdminUser, Session, type Student } from "../../src/panel/security.js";
import { speedOptions, tutorOptions } from "../../src/panel/student-routes.js";
import { formatPhone, messageFor, scoreChart, Views } from "../../src/panel/views.js";

describe("views", () => {
  it("score chart points: oldest first, 0-100 mapped to the height", () => {
    const day = (avg: number) => ({ day: "2026-09-01", avg, n: 1 });
    expect(scoreChart([])).toBe("");
    expect(scoreChart([day(50)])).toBe("");
    expect(scoreChart([day(0), day(50), day(100)])).toBe("0.0,180.0 320.0,90.0 640.0,0.0");
    expect(scoreChart([day(75), day(33)], 100, 10)).toBe("0.0,2.5 100.0,6.7");
  });

  it("phone filter formats Brazilian numbers only", () => {
    expect(formatPhone("5511987654321")).toBe("+55 11 98765-4321");
    expect(formatPhone("551187654321")).toBe("+55 11 8765-4321");
    expect(formatPhone("14155550123")).toBe("+14155550123");
  });

  it("messages come from the fixed list only", () => {
    expect(messageFor("saved")).toBe("Alterações salvas.");
    expect(messageFor("<script>")).toBe("");
    expect(messageFor("constructor")).toBe("");
    expect(messageFor(undefined)).toBe("");
  });

  it("password rules and the wa.me text", () => {
    expect(newPasswordError("segredo123", "segredo124")).toBe("As senhas não conferem.");
    expect(newPasswordError("curta", "curta")).toContain("8 caracteres");
    expect(newPasswordError("segredo123", "segredo123")).toBe("");
    expect(quote("ATIVAR 123456")).toBe("ATIVAR%20123456");
    expect(quote("a/b!c")).toBe("a/b%21c");
  });

  it("student options list every tutor and speed", () => {
    expect(tutorOptions().map((t) => t.value)).toEqual(["emma", "sarah", "george", "michael"]);
    expect(speedOptions().map((s) => s.value)).toEqual([1, 0.9, 0.8, 0.7]);
    expect(speedOptions()[2]?.label).toMatch(/^0,8x — /);
  });
});

// Every template renders with realistic data (outputting null/undefined would throw).
describe("templates", () => {
  const views = new Views(`${PROJECT_ROOT}/templates`);
  const when = new Date("2026-09-27T15:04:00Z");
  const plan: Plan = {
    id: 2,
    name: "Básico",
    description: "",
    messagesPerDay: 50,
    durationDays: null,
    isActive: true,
    createdAt: when,
    tutors: ["sarah"],
    speeds: [1, 0.9],
    nextPlanId: null,
    lessonsPerDay: 1,
  };
  const student: Student = {
    id: 7,
    connectionId: "meta-main",
    phone: "5511987654321",
    topic: "football",
    level: "B1",
    createdAt: when,
    name: null,
    status: "blocked",
    planId: 2,
    planStartedAt: when,
    planEndsAt: new Date("2026-11-01T02:59:59Z"),
    passwordHash: null,
    verifiedAt: when,
    notes: "",
    uiLang: null,
    tutor: null,
    speed: null,
    lastMessageAt: null,
    dailyGoal: 5,
    inRanking: true,
    reminders: true,
    remindedAt: null,
  };
  const turn: Turn = {
    id: 1,
    studentId: 7,
    kind: "audio",
    topic: "travel",
    level: "B1",
    transcript: "I goed <b>home</b>",
    evaluation: { mistakes: [{ original: "I goed" }], corrected: "I went home." },
    score: 72,
    replyText: null,
    blockedReason: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    errors: null,
    createdAt: when,
    notes: null,
  };
  const progress: Progress = {
    practices: 3,
    audio: 2,
    avgScore: 70,
    avgScoreWeek: null,
    daysActive: 2,
    streak: 1,
    today: 2,
    goodAtLevel: 12,
    daily: [
      { day: "2026-09-26", avg: 60, n: 1 },
      { day: "2026-09-27", avg: 80, n: 2 },
    ],
    topMistakes: [{ original: "i goed", correction: "I went", n: 2 }],
    recent: [turn],
  };
  const adminUser: AdminUser = {
    id: 1,
    email: "boss@saybest.test",
    name: "Boss",
    passwordHash: "x",
    role: "staff",
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: when,
  };
  const staff = new Session("s", "admin", "tok");
  staff.admin = adminUser;
  const pupil = new Session("p", "student", "tok");
  pupil.student = student;
  const base = { csrf: "tok", message: "", error: "", tz: "America/Sao_Paulo" };
  const render = (template: string, context: Record<string, unknown>) =>
    views.renderPage(template, { ...base, ...context });

  it("renders the team pages", () => {
    const stats = {
      active: 1,
      blocked: 1,
      newWeek: 0,
      turnsToday: 0,
      avgToday: null,
      errorsToday: 0,
      recent: [{ turn, student }],
    };
    const dashboard = render("admin_dashboard.html", { session: staff, stats });
    expect(dashboard).toContain("+55 11 98765-4321");
    expect(dashboard).toContain("27/09/2026 12:04");
    expect(dashboard).toContain("I goed &lt;b&gt;home&lt;/b&gt;");
    const row = { student, plan, turns: 3 };
    const page = render("admin_student.html", {
      session: staff,
      row,
      plans: [plan],
      statuses: STATUSES,
      levels: ["A1", "B1"],
      usedToday: 4,
      progress,
      turns: [turn],
    });
    expect(page).toContain('value="2026-10-31"'); // plan end shown as the local day
    expect(page).toContain("bloqueado");
    expect(page).toContain("50/dia");
    expect(page).not.toContain("/delete"); // staff
    const list = render("admin_students.html", {
      session: staff,
      rows: [row, { student, plan: null, turns: 0 }],
      total: 60,
      q: "",
      status: "",
      plan: 0,
      page: 0,
      plans: [plan],
      pageSize: 50,
    });
    expect(list).toContain("sem plano");
    expect(list).toContain("31/10/2026");
    expect(list).toContain("próximos");
    expect(render("admin_plans.html", { session: staff, plans: [plan] })).toContain("50/dia");
    const boss = new Session("b", "admin", "tok");
    boss.admin = { ...adminUser, role: "admin" };
    const other = { ...plan, id: 3, name: "Teste Ilimitado", nextPlanId: 2, tutors: null };
    const plans = render("admin_plans.html", {
      session: boss,
      plans: [plan, other],
      tutors: tutorOptions(),
      speeds: speedOptions(),
    });
    expect(plans).toContain('name="tutor_sarah" checked');
    expect(plans).toContain('name="tutor_emma" >'); // not in the free plan
    expect(plans).toContain('name="speed_90" checked');
    expect(plans).toContain('<option value="2" selected>Básico</option>'); // the trial's next plan
    expect(
      render("admin_student_new.html", {
        session: staff,
        plans: [plan],
        connections: ["meta-main"],
        form: {},
      }),
    ).toContain("meta-main");
    expect(render("password.html", { session: staff })).toContain("Trocar senha");
  });

  it("renders the admin pages", () => {
    const boss = new Session("b", "admin", "tok");
    boss.admin = { ...adminUser, role: "admin" };
    const users = render("admin_users.html", {
      session: boss,
      users: [boss.admin, { ...adminUser, id: 2, isActive: false, lastLoginAt: when }],
      newPassword: "abc",
      newEmail: "x@y.z",
    });
    expect(users).toContain("Senha provisória");
    expect(users).toContain("Ativar");
    const settings = render("admin_settings.html", {
      session: boss,
      config: { ...defaultRuntimeConfig(), session_idle_hours: "abc" },
      fields: SETTINGS_FIELDS,
      plans: ["Grátis"],
      connections: ["meta-main"],
    });
    expect(settings).toContain('name="signup_enabled" checked');
    expect(settings).toContain('name="rate_limit_per_minute" value=""');
    expect(settings).toContain('value="abc"');
    const audit = render("admin_audit.html", {
      session: boss,
      entries: [
        { createdAt: when, actor: "a", action: "login", target: "", details: { ip: "1" } },
        { createdAt: when, actor: "a", action: "x", target: "", details: null },
      ],
    });
    expect(audit).toContain("{&quot;ip&quot;:&quot;1&quot;}");
    const connections = render("admin_connections.html", {
      session: boss,
      connections: [{ id: "meta-main", name: "Main", provider: "meta", enabled: false }],
      base: "https://saybest.test",
    });
    expect(connections).toContain("https://saybest.test/webhooks/meta-main");
    expect(connections).toContain("Ligar");
  });

  it("renders the student pages", () => {
    const home = render("me_home.html", {
      session: pupil,
      row: { student, plan, turns: 0 },
      progress,
      usedToday: 3,
      chart: scoreChart(progress.daily),
      whatsapp: "5541999990000",
      goal: 5,
      way: { next: "B2", need: 40, good: 12, min: 75 },
      rank: { position: 2, points: 120 },
      ranked: 9,
    });
    expect(home).toContain("Olá, aluno!");
    expect(home).toContain("2/5");
    expect(home).toContain("Rumo ao B2");
    expect(home).toContain("12/40");
    expect(home).toContain("2º");
    const ranking = render("me_ranking.html", {
      session: pupil,
      top: [
        { studentId: 3, name: "Ana S.", points: 140, practices: 12, position: 1 },
        { studentId: 7, name: "Maria S.", points: 120, practices: 10, position: 2 },
      ],
      mine: null,
      myId: 7,
      inRanking: true,
      reminders: true,
      remindedAt: null,
      points: POINTS,
      maxPerDay: MAX_PRACTICES_A_DAY,
    });
    expect(ranking).toContain("Maria S. (você)");
    expect(ranking).toContain("140<small>pts</small>");
    expect(home).toContain("3 de 50");
    expect(home).toContain('points="0.0,72.0 640.0,36.0"');
    expect(home).toContain("I went home.");
    const settings = render("me_settings.html", {
      session: pupil,
      student,
      levels: [{ value: "B1", label: "Intermediário" }],
      topics: [{ value: "travel", label: "Viagem" }],
      customTopic: "football",
      tutors: tutorOptions(plan.tutors),
      tutor: "sarah",
      speeds: speedOptions(plan.speeds),
      speed: 1,
      locked: true,
      goals: DAILY_GOALS,
      goal: 7,
      maxGoal: 15,
    });
    expect(settings).toContain('<option value="football" selected>');
    expect(settings).toContain('<option value="1" selected>');
    expect(settings).toContain('<option value="emma"  disabled>'); // not in the plan
    expect(settings).toContain(
      'name="daily_goal" type="number" min="1" max="15" step="1" value="7"',
    );
    expect(settings).toContain('name="in_ranking" checked');
    expect(settings).not.toContain("Senha atual"); // no site password yet
  });

  it("renders the pages before login", () => {
    for (const [template, context] of [
      ["login.html", { phone: "" }],
      ["admin_login.html", { email: "" }],
      ["signup.html", { enabled: true, name: "", phone: "", lang: "en" }],
      ["signup.html", { enabled: false, name: "", phone: "", lang: "en" }],
      ["forgot.html", { phone: "" }],
      ["reset.html", { token: "t" }],
      ["wait.html", { code: "1", waText: "ATIVAR 1", link: "", status: "pending", number: "" }],
      ["wait.html", { code: "1", waText: "", link: "", status: "wrong_phone", number: "" }],
      ["wait.html", { code: "1", waText: "", link: "", status: "expired", number: "" }],
    ] as const) {
      expect(render(template, { session: null, ...context })).toContain("</html>");
    }
  });
});
