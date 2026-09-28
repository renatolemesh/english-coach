/** The student's area: progress, plan and settings. Settings are saved on `students`; the next
 * WhatsApp message loads them into the conversation (graph/runner.ts preferences()). */
import type { Context, Hono } from "hono";
import { hashPassword, passwordProblem, verifyPassword } from "../accounts/passwords.js";
import {
  DAILY_GOALS,
  GOOD_SCORE,
  goalAboveLimit,
  goalOf,
  LEVEL_UP,
  MAX_DAILY_GOAL,
  MAX_PRACTICES_A_DAY,
  nextLevel,
  POINTS,
  parseGoal,
  RANKING_SIZE,
} from "../domain/progress.js";
import { PT } from "../domain/texts.js";
import { cleanTopic, LEVELS, SUGGESTED_TOPICS } from "../domain/topics.js";
import {
  effectiveSpeed,
  effectiveTutor,
  SPEEDS,
  speedOffered,
  TUTORS,
  tutorOffered,
} from "../domain/tutors.js";
import { localDay } from "../guardrails/limits.js";
import { PASSWORD_ERRORS } from "./auth-routes.js";
import { type Panel, posted, student, target, text } from "./deps.js";
import type { Session } from "./security.js";
import { scoreChart } from "./views.js";

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export interface Option<T = string> {
  value: T;
  label: string;
  key: string; // form field suffix (plans page)
  locked: boolean; // the student's plan does not offer it
}

export function tutorOptions(offered: readonly string[] | null = null): Option[] {
  return Object.values(TUTORS).map((t) => ({
    value: t.id,
    label: `${t.name} — ${PT.tutorDescription(t.accent, t.gender)}`,
    key: t.id,
    locked: !tutorOffered(t.id, offered),
  }));
}

export function speedOptions(offered: readonly number[] | null = null): Option<number>[] {
  return [...SPEEDS].map(([key, value]) => ({
    value,
    label: `${PT.speedLabel(value)} — ${PT.speedNames[key] ?? key}`,
    key,
    locked: !speedOffered(value, offered),
  }));
}

export function studentRoutes(app: Hono, p: Panel): void {
  const me = (session: Session) => {
    if (!session.student) throw new Error("student session without a student");
    return session.student;
  };

  const current = async (session: Session) => {
    await p.queries.advancePlan(me(session).id); // an ended trial becomes the free plan
    const row = await p.queries.student(me(session).id);
    if (!row) throw new Error("student vanished");
    return row;
  };

  app.get("/me", async (c) => {
    const session = await student(p, c);
    const row = await current(session);
    const s = row.student;
    const config = await p.runtime.get();
    const queries = p.queries.inZone(config.timezone);
    const used = await p.deps.cache.get(`msgs:${s.id}:${localDay(config.timezone)}`);
    const progress = await queries.progress(s.id, s.dailyGoal, s.level);
    const ranking = await queries.ranking();
    const position = ranking.findIndex((r) => r.studentId === s.id);
    const need = LEVEL_UP[s.level] ?? 0;
    return p.views.render(c, "me_home.html", {
      session,
      row,
      progress,
      usedToday: used ? Math.trunc(Number(used.toString())) : 0,
      chart: scoreChart(progress.daily),
      whatsapp: config.whatsapp_number,
      tz: config.timezone,
      goal: goalOf(s.dailyGoal),
      way: {
        next: nextLevel(s.level),
        need,
        good: Math.min(progress.goodAtLevel, need),
        min: GOOD_SCORE,
      },
      rank: position >= 0 ? { position: position + 1, ...ranking[position] } : null,
      ranked: ranking.length,
    });
  });

  app.get("/me/ranking", async (c) => {
    const session = await student(p, c);
    const config = await p.runtime.get();
    const ranking = await p.queries.inZone(config.timezone).ranking();
    const id = me(session).id;
    const position = ranking.findIndex((r) => r.studentId === id);
    return p.views.render(c, "me_ranking.html", {
      session,
      top: ranking.slice(0, RANKING_SIZE).map((r, i) => ({ ...r, position: i + 1 })),
      mine: position >= RANKING_SIZE ? { ...ranking[position], position: position + 1 } : null,
      myId: id,
      inRanking: me(session).inRanking,
      points: POINTS,
      maxPerDay: MAX_PRACTICES_A_DAY,
    });
  });

  const settingsPage = async (c: Context, session: Session, status = 200, error = "") => {
    const config = await p.runtime.get();
    const { student: s, plan } = await current(session);
    const topics = SUGGESTED_TOPICS.map((t) => ({ value: t, label: PT.topicNames[t] ?? t }));
    const topic = me(session).topic;
    return p.views.render(c, "me_settings.html", {
      session,
      statusCode: status,
      error,
      student: me(session),
      levels: LEVELS.map((lv) => ({ value: lv, label: PT.levelNames[lv] ?? lv })),
      topics,
      // a topic of their own (typed here or in WhatsApp) stays selectable
      customTopic: topic && !SUGGESTED_TOPICS.includes(topic) ? topic : "",
      tutors: tutorOptions(plan?.tutors),
      // what plays now: the saved choice within the plan (a locked choice stays saved)
      tutor: effectiveTutor(s.tutor || config.default_tutor, plan?.tutors).id,
      speeds: speedOptions(plan?.speeds),
      speed: effectiveSpeed(s.speed ?? 1, plan?.speeds),
      locked: Boolean(plan?.tutors || plan?.speeds),
      goals: DAILY_GOALS,
      goal: goalOf(s.dailyGoal),
      maxGoal: Math.min(MAX_DAILY_GOAL, plan?.messagesPerDay || MAX_DAILY_GOAL),
    });
  };

  app.get("/me/settings", async (c) => settingsPage(c, await student(p, c)));

  app.post("/me/settings", async (c) => {
    const session = await student(p, c);
    const form = await posted(c, session);
    const level = text(form, "level", 4);
    const tutor = text(form, "tutor", 16);
    const lang = text(form, "ui_lang", 4);
    const rawSpeed = text(form, "speed", 5) || "1";
    const speed = NUMBER.test(rawSpeed) ? Number(rawSpeed) : 0; // 0 is refused below
    const custom = text(form, "custom_topic", 60);
    const topic = custom ? cleanTopic(custom) : text(form, "topic", 120);
    const goal = parseGoal(text(form, "daily_goal", 3));
    if (
      !(LEVELS as readonly string[]).includes(level) ||
      !Object.hasOwn(TUTORS, tutor) ||
      !["en", "pt"].includes(lang) ||
      ![...SPEEDS.values()].includes(speed) ||
      goal === null ||
      !topic
    ) {
      return settingsPage(c, session, 400, "Algum valor é inválido.");
    }
    const { plan } = await current(session);
    if (goalAboveLimit(goal, plan?.messagesPerDay)) {
      const limit = plan?.messagesPerDay;
      return settingsPage(
        c,
        session,
        400,
        `A meta pode ser de até ${limit} (o limite do seu plano).`,
      );
    }
    if (!tutorOffered(tutor, plan?.tutors) || !speedOffered(speed, plan?.speeds)) {
      return settingsPage(c, session, 400, "Essa voz ou velocidade faz parte dos planos pagos.");
    }
    await p.queries.updateStudent(me(session).id, {
      name: text(form, "name", 120) || me(session).name,
      level,
      tutor,
      uiLang: lang,
      speed,
      topic,
      dailyGoal: goal,
      inRanking: form.in_ranking === "on",
    });
    return c.redirect(target("/me/settings?m=saved"), 303);
  });

  app.post("/me/password", async (c) => {
    const session = await student(p, c);
    const form = await posted(c, session);
    const current = me(session);
    const password = form.password ?? "";
    if (current.passwordHash && !(await verifyPassword(form.current ?? "", current.passwordHash))) {
      return settingsPage(c, session, 400, "Senha atual incorreta.");
    }
    if (password !== (form.password2 ?? "")) {
      return settingsPage(c, session, 400, PASSWORD_ERRORS.mismatch);
    }
    const problem = passwordProblem(password);
    if (problem) return settingsPage(c, session, 400, PASSWORD_ERRORS[problem]);
    await p.queries.updateStudent(current.id, { passwordHash: await hashPassword(password) });
    await p.sessions.endAll("student", current.id);
    await p.sessions.create(c, "student", current.id);
    return c.redirect(target("/me/settings?m=password"), 303);
  });
}
