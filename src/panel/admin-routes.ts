/** Panel for the team. staff: dashboard and students. admin: also plans, settings, panel users,
 * WhatsApp connections and the audit log. Every change is written to the audit log. */
import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import { hashPassword } from "../accounts/passwords.js";
import { fromForm, PHONE_HINT } from "../accounts/phones.js";
import { defaultRuntimeConfig, RuntimeConfigSchema } from "../accounts/runtime.js";
import { LEVELS } from "../domain/topics.js";
import { SPEEDS, TUTORS } from "../domain/tutors.js";
import { localDay } from "../guardrails/limits.js";
import {
  admin,
  asDict,
  type Form,
  notFound,
  optionalInt,
  type Panel,
  posted,
  queryInt,
  staff,
  target,
  text,
} from "./deps.js";
import { PAGE } from "./queries.js";
import { type Session, tokenUrlsafe } from "./security.js";
import { speedOptions, tutorOptions } from "./student-routes.js";
import { endOfDay } from "./zones.js";

export const STATUSES = ["active", "blocked"] as const;
const ID = ":id{[0-9]+}";

/** The settings form: one entry per RuntimeConfig field, in order. */
export const SETTINGS_FIELDS = (() => {
  const defaults = defaultRuntimeConfig() as Record<string, unknown>;
  return Object.entries(RuntimeConfigSchema.shape).map(([name, schema]) => ({
    name,
    description: schema.description ?? name,
    isBool: typeof defaults[name] === "boolean",
    defaultNull: defaults[name] === null,
  }));
})();

const go = (c: Context, path: string, message = "") =>
  c.redirect(target(`/admin${path}`, message), 303);

export function adminRoutes(app: Hono, p: Panel): void {
  const config = () => p.runtime.get();
  const queriesFor = async () => p.queries.inZone((await config()).timezone);
  const id = (c: Context) => Number(c.req.param("id"));

  // --- dashboard -----------------------------------------------------------------------------
  app.get("/admin", async (c) => {
    const session = await staff(p, c);
    const stats = await (await queriesFor()).dashboard();
    return p.views.render(c, "admin_dashboard.html", {
      session,
      stats,
      tz: (await config()).timezone,
    });
  });

  // --- students ------------------------------------------------------------------------------
  app.get("/admin/students", async (c) => {
    const session = await staff(p, c);
    const q = c.req.query("q") ?? "";
    const status = c.req.query("status") ?? "";
    const plan = queryInt(c, "plan");
    const page = queryInt(c, "page");
    const [rows, total] = await p.queries.students(
      q.slice(0, 60),
      (STATUSES as readonly string[]).includes(status) ? status : "",
      plan || null,
      Math.max(page, 0),
    );
    return p.views.render(c, "admin_students.html", {
      session,
      rows,
      total,
      q,
      status,
      plan,
      page,
      plans: await p.queries.plans(),
      pageSize: PAGE,
      tz: (await config()).timezone,
    });
  });

  const newPage = async (
    c: Context,
    session: Session,
    status = 200,
    form: Form = {},
    error = "",
  ) => {
    const connections = await p.deps.connections.list();
    return p.views.render(c, "admin_student_new.html", {
      session,
      statusCode: status,
      error,
      plans: await p.queries.plans(true),
      connections: connections.map((conn) => conn.id),
      form,
    });
  };

  app.get("/admin/students/new", async (c) => newPage(c, await staff(p, c)));

  app.post("/admin/students/new", async (c) => {
    const session = await staff(p, c);
    const form = await posted(c, session);
    const phone = fromForm(text(form, "phone", 30));
    const name = text(form, "name", 120);
    const connection = text(form, "connection", 64);
    const plan = await p.queries.plan(optionalInt(form, "plan_id") ?? 0);
    const values = asDict(form);
    if (phone === null) return newPage(c, session, 400, values, PHONE_HINT);
    if ((await p.queries.studentsByPhone(phone)).length) {
      return newPage(c, session, 400, values, "Já existe um aluno com esse telefone.");
    }
    // the number as WhatsApp sends it may lack the 9th digit: the student's first message
    // from WhatsApp is matched by variants (studentsByPhone), see accounts/phones.ts
    const studentId = await p.queries.createStudent(connection, phone, {
      name: name || null,
      status: "active",
      verifiedAt: new Date(),
    });
    await p.queries.setPlan(studentId, plan, null);
    await p.queries.audit(session.actor, "create_student", `student:${studentId}`, {
      phone,
      plan: plan ? plan.name : null,
    });
    return go(c, `/students/${studentId}`, "created");
  });

  const studentPage = async (
    c: Context,
    session: Session,
    studentId: number,
    status = 200,
    error = "",
  ) => {
    await p.queries.advancePlan(studentId);
    const row = await p.queries.student(studentId);
    if (!row) throw notFound();
    const { timezone } = await config();
    const queries = p.queries.inZone(timezone);
    const used = await p.deps.cache.get(`msgs:${studentId}:${localDay(timezone)}`);
    return p.views.render(c, "admin_student.html", {
      session,
      statusCode: status,
      error,
      row,
      plans: await queries.plans(),
      statuses: STATUSES,
      levels: LEVELS,
      usedToday: used ? Math.trunc(Number(used.toString())) : 0,
      progress: await queries.progress(studentId, row.student.dailyGoal, row.student.level),
      turns: await queries.recentTurns(studentId, 15),
      tz: timezone,
    });
  };

  app.get(`/admin/students/${ID}`, async (c) => studentPage(c, await staff(p, c), id(c)));

  app.post(`/admin/students/${ID}`, async (c) => {
    const session = await staff(p, c);
    const form = await posted(c, session);
    const studentId = id(c);
    const row = await p.queries.student(studentId);
    if (!row) throw notFound();
    const status = text(form, "status", 16);
    const level = text(form, "level", 4);
    if (
      !(STATUSES as readonly string[]).includes(status) ||
      !(LEVELS as readonly string[]).includes(level)
    ) {
      return studentPage(c, session, studentId, 400, "Valor inválido.");
    }
    const { timezone } = await config();
    const endsAt = endOfDay(text(form, "plan_ends_at", 10), timezone);
    const planId = optionalInt(form, "plan_id");
    await p.queries.updateStudent(studentId, {
      name: text(form, "name", 120) || null,
      status,
      level,
      notes: text(form, "notes", 2000),
    });
    if (planId !== row.student.planId) {
      // new plan: its period starts now
      await p.queries.setPlan(studentId, await p.queries.plan(planId ?? 0), endsAt);
    } else {
      await p.queries.updateStudent(studentId, { planEndsAt: endsAt });
    }
    if (status === "blocked") await p.sessions.endAll("student", studentId);
    await p.queries.audit(session.actor, "update_student", `student:${studentId}`, {
      status,
      plan_id: planId,
      ends: endsAt ? endsAt.toISOString() : null,
    });
    return go(c, `/students/${studentId}`, "saved");
  });

  app.post(`/admin/students/${ID}/reset-today`, async (c) => {
    const session = await staff(p, c);
    await posted(c, session);
    const studentId = id(c);
    const { timezone } = await config();
    await p.deps.cache.delete(`msgs:${studentId}:${localDay(timezone)}`);
    await p.queries.audit(session.actor, "reset_today", `student:${studentId}`);
    return go(c, `/students/${studentId}`, "reset_today");
  });

  app.post(`/admin/students/${ID}/delete`, async (c) => {
    const session = await admin(p, c);
    await posted(c, session);
    const studentId = id(c);
    const row = await p.queries.student(studentId);
    if (!row) throw notFound();
    await p.sessions.endAll("student", studentId);
    await p.queries.deleteStudent(studentId);
    await p.queries.audit(session.actor, "delete_student", `student:${studentId}`, {
      phone: row.student.phone,
    });
    return go(c, "/students", "deleted");
  });

  // --- plans ---------------------------------------------------------------------------------
  const plansPage = async (c: Context, session: Session, status = 200, error = "") =>
    p.views.render(c, "admin_plans.html", {
      session,
      statusCode: status,
      error,
      plans: await p.queries.plans(),
      tutors: tutorOptions(),
      speeds: speedOptions(),
    });

  app.get("/admin/plans", async (c) => plansPage(c, await staff(p, c)));

  app.post("/admin/plans", async (c) => {
    const session = await admin(p, c);
    const form = await posted(c, session);
    const name = text(form, "name", 60);
    if (!name) return plansPage(c, session, 400, "O plano precisa de nome.");
    const planId = optionalInt(form, "id");
    const messagesPerDay = optionalInt(form, "messages_per_day");
    const durationDays = optionalInt(form, "duration_days");
    if (messagesPerDay === 0 || durationDays === 0) {
      // 0 would block every message while the panel shows "ilimitado"
      return plansPage(c, session, 400, "Use 1 ou mais (vazio = sem limite).");
    }
    const nextPlanId = optionalInt(form, "next_plan_id");
    if (nextPlanId !== null && (nextPlanId === planId || !(await p.queries.plan(nextPlanId)))) {
      return plansPage(c, session, 400, "Escolha outro plano para quando este terminar.");
    }
    // every box ticked (or none) means everything: new voices and speeds come with it
    const tutors = Object.keys(TUTORS).filter((id) => form[`tutor_${id}`] === "on");
    const speeds = [...SPEEDS].filter(([key]) => form[`speed_${key}`] === "on").map(([, v]) => v);
    const values = {
      name,
      description: text(form, "description", 300),
      messagesPerDay,
      durationDays,
      isActive: form.is_active === "on",
      tutors: tutors.length && tutors.length < Object.keys(TUTORS).length ? tutors : null,
      speeds: speeds.length && speeds.length < SPEEDS.size ? speeds : null,
      nextPlanId: durationDays ? nextPlanId : null,
    };
    let plan: Awaited<ReturnType<typeof p.queries.savePlan>>;
    try {
      plan = await p.queries.savePlan(planId, values);
    } catch {
      // unique name
      return plansPage(c, session, 400, "Já existe um plano com esse nome.");
    }
    await p.queries.audit(session.actor, "save_plan", `plan:${plan.id}`, {
      name: values.name,
      description: values.description,
      messages_per_day: values.messagesPerDay,
      duration_days: values.durationDays,
      is_active: values.isActive,
      tutors: values.tutors,
      speeds: values.speeds,
      next_plan_id: values.nextPlanId,
    });
    return go(c, "/plans", "saved");
  });

  // --- settings ------------------------------------------------------------------------------
  const settingsPage = async (
    c: Context,
    session: Session,
    status = 200,
    error = "",
    values: Record<string, unknown> | null = null,
  ) => {
    const current = await config();
    const plans = (await p.queries.plans(true)).map((plan) => plan.name);
    const connections = (await p.deps.connections.list()).map((conn) => conn.id);
    return p.views.render(c, "admin_settings.html", {
      session,
      statusCode: status,
      error,
      config: values ?? current,
      fields: SETTINGS_FIELDS,
      plans,
      connections,
    });
  };

  app.get("/admin/settings", async (c) => settingsPage(c, await admin(p, c)));

  app.post("/admin/settings", async (c) => {
    const session = await admin(p, c);
    const form = await posted(c, session);
    const values: Record<string, unknown> = {};
    for (const field of SETTINGS_FIELDS) {
      const raw = form[field.name];
      if (field.isBool) values[field.name] = raw === "on";
      else if (raw === undefined || (raw.trim() === "" && field.defaultNull)) {
        values[field.name] = null;
      } else values[field.name] = Array.from(raw.trim()).slice(0, 300).join("");
    }
    let saved: Awaited<ReturnType<typeof p.runtime.save>>;
    try {
      saved = await p.runtime.save(values, session.actor);
    } catch (exc) {
      if (!(exc instanceof ZodError)) throw exc;
      const problems = exc.issues.map((e) => `${String(e.path[0])}: ${e.message}`).join("; ");
      return settingsPage(c, session, 400, `Valores inválidos: ${problems}`, values);
    }
    await p.queries.audit(session.actor, "save_settings", "", { ...saved });
    return go(c, "/settings", "saved");
  });

  // --- panel users ---------------------------------------------------------------------------
  const usersPage = async (
    c: Context,
    session: Session,
    options: { status?: number; error?: string; newPassword?: string; newEmail?: string } = {},
  ) =>
    p.views.render(c, "admin_users.html", {
      session,
      statusCode: options.status ?? 200,
      error: options.error ?? "",
      users: await p.queries.admins(),
      newPassword: options.newPassword ?? "",
      newEmail: options.newEmail ?? "",
      tz: (await config()).timezone,
    });

  app.get("/admin/users", async (c) => usersPage(c, await admin(p, c)));

  app.post("/admin/users", async (c) => {
    const session = await admin(p, c);
    const form = await posted(c, session);
    const email = text(form, "email").toLowerCase();
    const name = text(form, "name", 120);
    const role = form.role === "admin" ? "admin" : "staff";
    if (!email.includes("@") || !name) {
      return usersPage(c, session, { status: 400, error: "Informe nome e e-mail." });
    }
    const password = tokenUrlsafe(9);
    try {
      await p.queries.createAdmin(email, name, role, await hashPassword(password));
    } catch {
      return usersPage(c, session, { status: 400, error: "Esse e-mail já tem acesso." });
    }
    await p.queries.audit(session.actor, "create_user", email, { role });
    // shown once to the admin who created it; the new user must change it at first login
    return usersPage(c, session, { newPassword: password, newEmail: email });
  });

  app.post(`/admin/users/${ID}`, async (c) => {
    const session = await admin(p, c);
    const form = await posted(c, session);
    const userId = id(c);
    const user = await p.queries.admin(userId);
    if (!user) throw notFound();
    const action = text(form, "action", 20);
    if (user.id === session.admin?.id && action !== "reset") {
      return go(c, "/users"); // nobody disables or demotes themselves (always one admin left)
    }
    let password = "";
    if (action === "toggle") {
      await p.queries.updateAdmin(userId, { isActive: !user.isActive });
      await p.sessions.endAll("admin", userId);
    } else if (action === "role") {
      await p.queries.updateAdmin(userId, { role: user.role === "admin" ? "staff" : "admin" });
    } else if (action === "reset") {
      password = tokenUrlsafe(9);
      await p.queries.updateAdmin(userId, {
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      });
      await p.sessions.endAll("admin", userId);
    }
    await p.queries.audit(session.actor, `user_${action}`, user.email);
    if (password) return usersPage(c, session, { newPassword: password, newEmail: user.email });
    return go(c, "/users", "saved");
  });

  // --- connections and audit -----------------------------------------------------------------
  app.get("/admin/connections", async (c) => {
    const session = await admin(p, c);
    return p.views.render(c, "admin_connections.html", {
      session,
      connections: await p.deps.connections.list(),
      base: p.deps.settings.publicBaseUrl.replace(/\/+$/, ""),
    });
  });

  app.post("/admin/connections/:id", async (c) => {
    const session = await admin(p, c);
    await posted(c, session);
    const connectionId = c.req.param("id");
    const conn = await p.deps.connections.get(connectionId);
    if (!conn) throw notFound();
    const enabled = !conn.enabled;
    await p.deps.connections.setEnabled(connectionId, enabled);
    p.deps.invalidateConnection(connectionId);
    await p.queries.audit(session.actor, "toggle_connection", connectionId, { enabled });
    return go(c, "/connections", enabled ? "enabled" : "disabled");
  });

  app.get("/admin/audit", async (c) => {
    const session = await admin(p, c);
    return p.views.render(c, "admin_audit.html", {
      session,
      entries: await p.queries.auditLog(),
      tz: (await config()).timezone,
    });
  });
}
