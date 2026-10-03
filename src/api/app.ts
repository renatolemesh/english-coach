/** Hono application factory (the API process: webhooks, admin, health). */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { RedisCache } from "../adapters/cache/redis.js";
import type { Settings } from "../config.js";
import { CredentialCipher } from "../connections/crypto.js";
import { EventLog } from "../connections/events.js";
import { ChannelPool } from "../connections/pool.js";
import { ConnectionStore } from "../connections/store.js";
import { loadConnectionsYaml } from "../connections/yaml-loader.js";
import { connect } from "../db/client.js";
import { getLogger } from "../logging.js";
import { createPanel, landingPage } from "../panel/index.js";
import { BullTaskQueue } from "../worker/queue.js";
import { adminRouter } from "./admin.js";
import { appRouter } from "./app-api.js";
import type { AppState } from "./deps.js";
import { httpError } from "./errors.js";
import { webhooksRouter } from "./webhooks.js";

const log = getLogger("coach.api.app");
// The Flutter web app: its own scripts and WebAssembly (CanvasKit), fonts for accents and emoji
// from Google's font CDN, the microphone and the tutor's audio from this site.
export const APP_WEB_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: " +
    "https://fonts.gstatic.com; connect-src 'self' blob: https://fonts.gstatic.com; " +
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

// No scripts at all in the panel; forms post only to itself; never framed.
export const PANEL_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/** Real dependencies: Redis, Postgres, connections (+ connections.yaml upserted at boot). */
export async function buildState(
  settings: Settings,
): Promise<{ state: AppState; close: () => Promise<void> }> {
  const cache = RedisCache.fromUrl(settings.redisUrl);
  const database = connect(settings.databaseUrl);
  const store = new ConnectionStore(database.db, new CredentialCipher(settings.fernetKey.value));
  const file = settings.connectionsFile;
  if (file && existsSync(file) && statSync(file).isFile()) {
    for (const conn of loadConnectionsYaml(file)) {
      await store.save(conn);
      log.info("connection_loaded", { connection_id: conn.id, provider: conn.provider });
    }
  }
  const pool = new ChannelPool(store, settings);
  const queue = new BullTaskQueue(settings.redisUrl);
  const state: AppState = {
    settings,
    cache,
    connections: store,
    pool,
    events: new EventLog(database.db),
    queue,
    db: database,
  };
  const close = async () => {
    await pool.close();
    await queue.close();
    await cache.close();
    await database.close();
  };
  return { state, close };
}

export function createApp(state: AppState): Hono {
  const app = new Hono();

  app.use("/panel/*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PANEL_HEADERS)) c.res.headers.set(name, value);
  });

  app.get("/health", async (c) => {
    let redis = "n/a";
    if (state.cache instanceof RedisCache) {
      try {
        redis = (await state.cache.ping()) ? "ok" : "down";
      } catch {
        redis = "down";
      }
    }
    return c.json({ status: "ok", redis });
  });

  app.get("/", landingPage(state.settings)); // the public site (nginx proxies only "/" exactly)
  serveAppWeb(app, state.settings.appWebDir);
  app.route("/webhooks", webhooksRouter(state));
  app.route("/admin", adminRouter(state));
  if (state.db) {
    app.route("/app/v1", appRouter(state)); // the Flutter app (docs/multicanal.md)
    const { connections, pool } = state;
    app.route(
      "/panel",
      createPanel({
        settings: state.settings,
        cache: state.cache,
        db: state.db.db,
        connections: {
          list: async () =>
            (await connections.list()).map(({ id, name, provider, enabled }) => ({
              id,
              name,
              provider,
              enabled,
            })),
          get: (id) => connections.get(id),
          setEnabled: (id, on) => connections.setEnabled(id, on),
        },
        invalidateConnection: (id) => pool.invalidate(id),
      }),
    );
  }
  app.notFound((c) => httpError(c, 404));
  app.onError((exc, c) => {
    log.exception("request_failed", exc, { path: c.req.path });
    return httpError(c, 500, "Internal Server Error");
  });
  return app;
}

/** The Flutter web build at /app/ (index.html for any other path under it: the app routes). */
export function serveAppWeb(app: Hono, dir: string): void {
  if (!existsSync(path.join(dir, "index.html"))) return; // not built on this machine
  const files = serveStatic({ root: dir, rewriteRequestPath: (p) => p.replace(/^\/app/, "") });
  app.get("/app", (c) => c.redirect("/app/", 301));
  app.use("/app/*", async (c, next) => {
    if (c.req.path.startsWith("/app/v1/")) return next();
    const found = (await files(c, async () => {})) as Response | undefined;
    const res =
      found && found.status < 400
        ? found
        : new Response(await readFile(path.join(dir, "index.html")), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(APP_WEB_HEADERS)) headers.set(name, value);
    const html = headers.get("content-type")?.startsWith("text/html");
    headers.set("cache-control", html ? "no-cache" : "public, max-age=3600");
    return new Response(res.body, { status: res.status, headers });
  });
}
