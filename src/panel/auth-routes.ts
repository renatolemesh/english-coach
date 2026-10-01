/**
 * Login, signup and password reset (students) and login / password change (panel users).
 *
 * Signup and reset prove the phone with a code the student sends from WhatsApp
 * (accounts/verification.ts): the page shows the code and a wa.me link, refreshes every few
 * seconds, and continues when the bot has seen the code (token status "done").
 */
import type { Context, Hono } from "hono";
import { hashPassword, passwordProblem, verifyPassword } from "../accounts/passwords.js";
import { fromForm, PHONE_HINT } from "../accounts/phones.js";
import * as verification from "../accounts/verification.js";
import { current, type Panel, posted, staff, target, text } from "./deps.js";
import { clientIp, preCsrfToken, setPreCsrf } from "./security.js";
import type { RenderOptions } from "./views.js";

export const PASSWORD_ERRORS = {
  too_short: "A senha precisa ter pelo menos 8 caracteres.",
  too_long: "Senha longa demais.",
  mismatch: "As senhas não conferem.",
} as const;
export const WAIT_REFRESH_S = 4;

/** Why a new password is refused (a message), or "". */
export function newPasswordError(password: string, again: string): string {
  if (password !== again) return PASSWORD_ERRORS.mismatch;
  const problem = passwordProblem(password);
  return problem ? PASSWORD_ERRORS[problem] : "";
}

export function authRoutes(app: Hono, p: Panel): void {
  const cache = p.deps.cache;

  /** A page for people not logged in: its forms carry the pre-login CSRF token. */
  const anon = (c: Context, template: string, options: RenderOptions = {}) => {
    const token = preCsrfToken(c);
    setPreCsrf(c, token);
    return p.views.render(c, template, { ...options, csrf: token });
  };

  const home = async (c: Context) => {
    const session = await current(p, c);
    if (session?.admin) return c.redirect(target("/admin"), 303);
    if (session?.student) return c.redirect(target("/me"), 303);
    return c.redirect(target("/login"), 303);
  };
  app.get("/", home);
  // "/panel/" (the brand link): a route "/" inside a mounted app only matches "/panel"
  app.get("/*", async (c, next) => (/^\/[^/]+\/$/.test(c.req.path) ? home(c) : next()));

  // --- students: login -----------------------------------------------------------------------
  app.get("/login", (c) => anon(c, "login.html", { phone: "" }));
  app.get("/creditos", (c) => p.views.render(c, "credits.html")); // data licences (course)

  app.post("/login", async (c) => {
    const form = await posted(c, null);
    const typed = text(form, "phone", 30);
    const phone = fromForm(typed);
    if (phone === null) {
      return anon(c, "login.html", { statusCode: 400, phone: typed, error: PHONE_HINT });
    }
    const password = form.password ?? "";
    const ip = clientIp(c);
    if (await p.throttle.blocked(ip, phone)) {
      return anon(c, "login.html", {
        statusCode: 429,
        phone,
        error: "Muitas tentativas. Espere 15 minutos.",
      });
    }
    for (const student of await p.queries.studentsByPhone(phone)) {
      if (student.status !== "blocked" && (await verifyPassword(password, student.passwordHash))) {
        await p.throttle.succeeded(phone);
        await p.sessions.create(c, "student", student.id);
        return c.redirect(target("/me"), 303);
      }
    }
    await p.throttle.failed(ip, phone);
    return anon(c, "login.html", {
      statusCode: 401,
      phone,
      error: "Telefone ou senha incorretos.",
    });
  });

  // --- students: signup ----------------------------------------------------------------------
  app.get("/signup", async (c) => {
    const config = await p.runtime.get();
    return anon(c, "signup.html", {
      enabled: config.signup_enabled,
      name: "",
      phone: "",
      lang: "auto",
    });
  });

  app.post("/signup", async (c) => {
    const form = await posted(c, null);
    const config = await p.runtime.get();
    const name = text(form, "name", 120);
    const typed = text(form, "phone", 30);
    const phone = fromForm(typed) ?? "";
    const lang = form.lang === "pt" || form.lang === "en" ? form.lang : "auto"; // auto: by level
    const ctx = { enabled: config.signup_enabled, name, phone: phone || typed, lang };
    if (!config.signup_enabled) return anon(c, "signup.html", { statusCode: 403, ...ctx });
    let error = "";
    if (!name) error = "Diga seu nome.";
    else if (!phone) error = PHONE_HINT;
    else error = newPasswordError(form.password ?? "", form.password2 ?? "");
    if (!error && !(await p.throttle.signupAllowed(clientIp(c)))) {
      error = "Muitos cadastros deste endereço. Tente mais tarde.";
    }
    if (error) return anon(c, "signup.html", { statusCode: 400, error, ...ctx });
    const token = verification.newToken();
    const code = await verification.start(cache, {
      kind: "signup",
      token,
      phone,
      name,
      lang,
      password_hash: await hashPassword(form.password ?? ""),
    });
    return c.redirect(target(`/signup/wait?t=${token}&c=${code}`), 303);
  });

  app.get("/signup/wait", async (c) => {
    const token = c.req.query("t") ?? "";
    const status = await verification.status(cache, token);
    if (status.status === "done" && status.user_id) {
      await p.sessions.create(c, "student", status.user_id);
      await verification.setStatus(cache, token, { status: "expired" }); // the link logs in once
      return c.redirect(target("/me?m=welcome"), 303);
    }
    return waitPage(c, "ATIVAR", c.req.query("c") ?? "", status.status);
  });

  // --- students: password reset --------------------------------------------------------------
  app.get("/forgot", (c) => anon(c, "forgot.html", { phone: "" }));

  app.post("/forgot", async (c) => {
    const form = await posted(c, null);
    const typed = text(form, "phone", 30);
    const phone = fromForm(typed);
    if (phone === null)
      return anon(c, "forgot.html", { statusCode: 400, phone: typed, error: PHONE_HINT });
    if (!(await p.throttle.signupAllowed(clientIp(c)))) {
      return anon(c, "forgot.html", {
        statusCode: 429,
        phone,
        error: "Muitas tentativas. Tente mais tarde.",
      });
    }
    const found = await p.queries.studentsByPhone(phone);
    const token = verification.newToken();
    // the same page whether the number exists or not: nobody learns who is a student
    const code = await verification.start(cache, {
      kind: "reset",
      token,
      phone,
      user_id: found[0]?.id ?? null,
    });
    return c.redirect(target(`/forgot/wait?t=${token}&c=${code}`), 303);
  });

  app.get("/forgot/wait", async (c) => {
    const token = c.req.query("t") ?? "";
    const status = await verification.status(cache, token);
    if (status.status === "done" && status.user_id) return anon(c, "reset.html", { token });
    return waitPage(c, "SENHA", c.req.query("c") ?? "", status.status);
  });

  app.post("/forgot/reset", async (c) => {
    const form = await posted(c, null);
    const token = text(form, "token", 64);
    const status = await verification.status(cache, token);
    if (status.status !== "done" || !status.user_id) {
      return c.redirect(target("/forgot?m=expired"), 303);
    }
    const error = newPasswordError(form.password ?? "", form.password2 ?? "");
    if (error) return anon(c, "reset.html", { statusCode: 400, token, error });
    await p.queries.updateStudent(status.user_id, {
      passwordHash: await hashPassword(form.password ?? ""),
    });
    await verification.setStatus(cache, token, { status: "expired" });
    await p.sessions.endAll("student", status.user_id);
    await p.sessions.create(c, "student", status.user_id);
    return c.redirect(target("/me?m=password"), 303);
  });

  const waitPage = async (c: Context, word: string, code: string, status: string) => {
    const config = await p.runtime.get();
    const message = `${word} ${code}`;
    const number = config.whatsapp_number.replace(/\D/g, "");
    const link = number ? `https://wa.me/${number}?text=${quote(message)}` : "";
    const response = p.views.render(c, "wait.html", {
      code,
      waText: message,
      link,
      status,
      number,
    });
    if (status === "pending") response.headers.set("Refresh", String(WAIT_REFRESH_S));
    return response;
  };

  // --- panel users ---------------------------------------------------------------------------
  app.get("/admin/login", (c) => anon(c, "admin_login.html", { email: "" }));

  app.post("/admin/login", async (c) => {
    const form = await posted(c, null);
    const email = text(form, "email").toLowerCase();
    const password = form.password ?? "";
    const ip = clientIp(c);
    if (await p.throttle.blocked(ip, email)) {
      return anon(c, "admin_login.html", {
        statusCode: 429,
        email,
        error: "Muitas tentativas. Espere 15 minutos.",
      });
    }
    const user = await p.sessions.adminByEmail(email);
    if (!user?.isActive || !(await verifyPassword(password, user.passwordHash))) {
      await p.throttle.failed(ip, email);
      return anon(c, "admin_login.html", {
        statusCode: 401,
        email,
        error: "E-mail ou senha incorretos.",
      });
    }
    await p.throttle.succeeded(email);
    await p.sessions.touchLogin(user.id);
    await p.sessions.purgeExpired();
    await p.queries.audit(`${user.role}:${user.email}`, "login", "", { ip });
    await p.sessions.create(c, "admin", user.id);
    return c.redirect(target("/admin"), 303);
  });

  app.get("/admin/password", async (c) => {
    const session = await staff(p, c, true);
    return p.views.render(c, "password.html", { session });
  });

  app.post("/admin/password", async (c) => {
    const session = await staff(p, c, true);
    const form = await posted(c, session);
    const user = session.admin;
    if (!user) throw new Error("staff session without a user");
    if (!(await verifyPassword(form.current ?? "", user.passwordHash))) {
      return p.views.render(c, "password.html", {
        session,
        statusCode: 400,
        error: "Senha atual incorreta.",
      });
    }
    const error = newPasswordError(form.password ?? "", form.password2 ?? "");
    if (error) return p.views.render(c, "password.html", { session, statusCode: 400, error });
    await p.queries.updateAdmin(user.id, {
      passwordHash: await hashPassword(form.password ?? ""),
      mustChangePassword: false,
    });
    await p.queries.audit(session.actor, "change_password");
    await p.sessions.endAll("admin", user.id);
    await p.sessions.create(c, "admin", user.id);
    return c.redirect(target("/admin?m=password"), 303);
  });

  app.post("/logout", async (c) => {
    const session = await current(p, c);
    await posted(c, session);
    const path = session?.admin ? "/admin/login" : "/login";
    await p.sessions.destroy(c, session);
    return c.redirect(target(`${path}?m=logged_out`), 303);
  });
}

/** Percent-encodes everything except unreserved characters (A-Z a-z 0-9 - _ . ~) and "/". */
export function quote(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%2F", "/");
}
