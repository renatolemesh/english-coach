/** Web panel at /panel: students (signup, progress, settings) and the team (admin/staff).
 * Server-rendered pages (templates/panel-ts), no JavaScript. A self-contained Hono app:
 * `app.route("/panel", createPanel(deps))`. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { RuntimeConfigStore } from "../accounts/runtime-store.js";
import { adminRoutes } from "./admin-routes.js";
import { authRoutes } from "./auth-routes.js";
import { HttpError, type Panel, type PanelDeps, Redirect } from "./deps.js";
import { PanelQueries } from "./queries.js";
import { Sessions, Throttle } from "./security.js";
import { studentRoutes } from "./student-routes.js";
import { Views } from "./views.js";

export type { ConnectionInfo, PanelDeps } from "./deps.js";

// No scripts at all in the panel; forms post only to itself; never framed.
export const PANEL_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

const FONTS = new Set([
  "inter-latin-400-normal.woff2",
  "inter-latin-600-normal.woff2",
  "inter-latin-800-normal.woff2",
]);

export function createPanel(deps: PanelDeps): Hono {
  const panel: Panel = {
    deps,
    queries: new PanelQueries(deps.db),
    sessions: new Sessions(deps.db),
    runtime: new RuntimeConfigStore(deps.db, deps.cache),
    throttle: new Throttle(deps.cache),
    views: new Views(deps.settings.templatesDir),
  };
  const stylesheet = path.join(deps.settings.templatesDir, "panel-ts", "static", "panel.css");
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PANEL_HEADERS)) c.res.headers.set(name, value);
  });

  app.onError((err, c) => {
    if (err instanceof Redirect) return c.redirect(err.location, 303);
    if (err instanceof HttpError) return c.json({ detail: err.detail }, err.status);
    throw err;
  });

  app.get("/static/panel.css", async (c) =>
    c.body(await readFile(stylesheet), 200, {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    }),
  );
  // Inter (OFL), the same files the evaluation card embeds; only these names are served
  const fontsDir = path.join(deps.settings.templatesDir, "fonts");
  app.get("/static/fonts/:name", async (c) => {
    const name = c.req.param("name");
    if (!FONTS.has(name)) return c.notFound();
    return c.body(await readFile(path.join(fontsDir, name)), 200, {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=604800, immutable",
    });
  });
  authRoutes(app, panel);
  adminRoutes(app, panel);
  studentRoutes(app, panel);
  return app;
}
