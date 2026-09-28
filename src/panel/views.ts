/**
 * Rendering of the panel pages (server-side Nunjucks, no JavaScript).
 *
 * Everything shown is escaped by autoescape; outputting an undefined or null value fails loudly
 * (throwOnUndefined). Messages after an action come from a fixed list (`?m=<key>`), never from
 * the URL text. Templates: templates/panel-ts (camelCase fields, the Drizzle rows as they are).
 */
import path from "node:path";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import nunjucks from "nunjucks";
import { formatFixed } from "../domain/format.js";
import type { DailyScore } from "./queries.js";
import type { Session } from "./security.js";
import { brDateTime, brDay, isoDay, safeZone } from "./zones.js";

export const MESSAGES: Readonly<Record<string, string>> = {
  saved: "Alterações salvas.",
  created: "Cadastro criado.",
  deleted: "Excluído.",
  password: "Senha alterada.",
  reset_today: "Contador de hoje zerado.",
  enabled: "Conexão ativada.",
  disabled: "Conexão desativada.",
  welcome: "Conta ativada! Bem-vindo ao saybest.",
  logged_out: "Você saiu.",
  expired: "O código expirou. Comece de novo.",
};

export function messageFor(key: string | undefined): string {
  return key && Object.hasOwn(MESSAGES, key) ? (MESSAGES[key] ?? "") : "";
}

/** 5511987654321 -> +55 11 98765-4321 (just for reading). */
export function formatPhone(value: string): string {
  if (value.startsWith("55") && (value.length === 12 || value.length === 13)) {
    const area = value.slice(2, 4);
    const rest = value.slice(4);
    return `+55 ${area} ${rest.slice(0, -4)}-${rest.slice(-4)}`;
  }
  return `+${value}`;
}

/** SVG polyline points for the daily average score (0-100), oldest first. */
export function scoreChart(daily: readonly DailyScore[], width = 640, height = 180): string {
  if (daily.length < 2) return "";
  const step = width / (daily.length - 1);
  return daily
    .map((d, i) => `${formatFixed(i * step, 1)},${formatFixed(height - (d.avg / 100) * height, 1)}`)
    .join(" ");
}

type Filter = (this: { ctx: Record<string, unknown> }, value: unknown) => string;
const zoneOf = (ctx: Record<string, unknown>) => safeZone(ctx.tz as string | undefined);
const asDate = (value: unknown) => (value instanceof Date ? value : null);

const filters: Record<string, Filter> = {
  local(value) {
    const date = asDate(value);
    return date ? brDateTime(date, zoneOf(this.ctx)) : "—";
  },
  day(value) {
    const date = asDate(value);
    return date ? brDay(date, zoneOf(this.ctx)) : "—";
  },
  // for <input type="date">
  isodate(value) {
    const date = asDate(value);
    return date ? isoDay(date, zoneOf(this.ctx)) : "";
  },
  phone(value) {
    return formatPhone(String(value ?? ""));
  },
  /** Color band of a 0-100 score: good (80+), mid (60-79), low. */
  scoreClass(value) {
    const n = Number(value);
    if (value === null || value === undefined || Number.isNaN(n)) return "none";
    return n >= 80 ? "good" : n >= 60 ? "mid" : "low";
  },
  kindLabel(value) {
    const labels: Record<string, string> = {
      audio: "áudio",
      text: "texto",
      command: "comando",
      blocked: "bloqueada",
    };
    return labels[String(value)] ?? String(value ?? "");
  },
};

export interface RenderOptions {
  session?: Session | null;
  statusCode?: number;
  csrf?: string;
  error?: string;
  tz?: string;
  [key: string]: unknown;
}

export class Views {
  private readonly env: nunjucks.Environment;

  constructor(templatesDir: string) {
    this.env = new nunjucks.Environment(
      new nunjucks.FileSystemLoader(path.join(templatesDir, "panel-ts")),
      { autoescape: true, throwOnUndefined: true, trimBlocks: true, lstripBlocks: true },
    );
    for (const [name, fn] of Object.entries(filters)) this.env.addFilter(name, fn);
  }

  renderPage(template: string, context: Record<string, unknown>): string {
    return this.env.render(template, context);
  }

  render(c: Context, template: string, options: RenderOptions = {}): Response {
    const { session = null, statusCode = 200, csrf = "", error = "", tz, ...context } = options;
    const page = this.renderPage(template, {
      session,
      csrf: session ? session.csrf : csrf,
      message: messageFor(c.req.query("m")),
      path: c.req.path, // the nav marks the current page
      error,
      tz: safeZone(tz),
      ...context,
    });
    return c.html(page, statusCode as ContentfulStatusCode, { "Cache-Control": "no-store" });
  }
}
