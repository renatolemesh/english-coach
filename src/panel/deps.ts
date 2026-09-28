/** Shared pieces of the panel routes: dependencies, current session, role checks, CSRF-checked
 * forms. Redirects and HTTP errors are thrown and turned into responses by createPanel. */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RuntimeConfigStore } from "../accounts/runtime-store.js";
import type { Settings } from "../config.js";
import type { Db } from "../db/client.js";
import type { Cache } from "../ports/cache.js";
import type { PanelQueries } from "./queries.js";
import {
  checkCsrf,
  PRE_CSRF_COOKIE,
  type Session,
  type Sessions,
  type Throttle,
} from "./security.js";
import type { Views } from "./views.js";

export const BASE = "/panel";

export interface ConnectionInfo {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
}

export interface PanelDeps {
  settings: Settings;
  cache: Cache;
  db: Db;
  connections: {
    list(): Promise<ConnectionInfo[]>;
    get(id: string): Promise<{ id: string; enabled: boolean } | null>;
    setEnabled(id: string, enabled: boolean): Promise<boolean>;
  };
  invalidateConnection(id: string): void;
}

/** Everything a route needs, built once per panel. */
export interface Panel {
  deps: PanelDeps;
  queries: PanelQueries;
  sessions: Sessions;
  runtime: RuntimeConfigStore;
  throttle: Throttle;
  views: Views;
}

/** Thrown to answer with a 303 redirect inside the panel. */
export class Redirect extends Error {
  constructor(readonly location: string) {
    super(`redirect to ${location}`);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export function target(path: string, message = ""): string {
  return `${BASE}${path}${message ? `?m=${message}` : ""}`;
}

export function redirect(path: string, message = ""): Redirect {
  return new Redirect(target(path, message));
}

export const notFound = () => new HttpError(404, "Not Found");

export async function current(p: Panel, c: Context): Promise<Session | null> {
  return p.sessions.load(c);
}

/** Any panel user (admin or staff); forces the first password change (except on its page). */
export async function staff(p: Panel, c: Context, passwordPage = false): Promise<Session> {
  const session = await current(p, c);
  if (!session?.admin) throw redirect("/admin/login");
  if (session.admin.mustChangePassword && !passwordPage) throw redirect("/admin/password");
  return session;
}

export async function admin(p: Panel, c: Context): Promise<Session> {
  const session = await staff(p, c);
  if (!session.isAdmin) throw new HttpError(403, "only admins");
  return session;
}

export async function student(p: Panel, c: Context): Promise<Session> {
  const session = await current(p, c);
  if (!session?.student) throw redirect("/login");
  return session;
}

export type Form = Record<string, string>;

/** The submitted form, after the CSRF check (session token, or the pre-login cookie). */
export async function posted(c: Context, session: Session | null): Promise<Form> {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.parseBody();
  } catch {
    // not a form: the CSRF check below refuses it
  }
  const form: Form = {};
  for (const [key, value] of Object.entries(body)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") form[key] = first;
  }
  const expected = session ? session.csrf : getCookie(c, PRE_CSRF_COOKIE);
  if (!checkCsrf(expected, form.csrf)) throw new HttpError(403, "invalid form, reload the page");
  return form;
}

/** A form field, trimmed and cut to maxLen code points ("" when missing). */
export function text(form: Form, name: string, maxLen = 200): string {
  return Array.from((form[name] ?? "").trim())
    .slice(0, maxLen)
    .join("");
}

export function optionalInt(form: Form, name: string): number | null {
  const value = text(form, name, 12);
  return /^[0-9]+$/.test(value) ? Number(value) : null;
}

export function asDict(form: Form): Form {
  const { csrf: _, ...rest } = form;
  return rest;
}

/** An integer query parameter (0 when missing or not a number). */
export function queryInt(c: Context, name: string): number {
  const value = Number(c.req.query(name) ?? "0");
  return Number.isInteger(value) ? value : 0;
}
