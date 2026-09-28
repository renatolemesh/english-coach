/**
 * Admin API for channel connections (n8n-style). Protected by the X-API-Key header and meant to
 * be reached only through `ssh -L` (nginx exposes /webhooks/ only).
 *
 *     GET    /admin/connections              list (secrets never returned)
 *     POST   /admin/connections              create
 *     GET    /admin/connections/:id
 *     PATCH  /admin/connections/:id          partial update (credentials/settings are merged)
 *     POST   /admin/connections/:id/enable
 *     POST   /admin/connections/:id/disable
 *     POST   /admin/connections/:id/test    send a test text to a number
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { HttpStatusError, safeEqual } from "../adapters/channels/base.js";
import { buildChannel, missingFields } from "../adapters/channels/registry.js";
import { NotImplementedChannelError } from "../adapters/channels/stub.js";
import { Secret } from "../config.js";
import { ConnectionConfig, Provider } from "../domain/connections.js";
import { getLogger } from "../logging.js";
import type { WhatsAppChannel } from "../ports/channel.js";
import type { AppState } from "./deps.js";
import { httpError } from "./errors.js";

const log = getLogger("coach.api.admin");

// .strict(): a typo must fail, not be silently ignored
export const ConnectionIn = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/),
    name: z.string().max(120),
    provider: Provider,
    enabled: z.boolean().default(true),
    credentials: z.record(z.string(), z.string()).default(() => ({})),
    webhook_secret: z.string().default(""),
    settings: z.record(z.string(), z.unknown()).default(() => ({})),
  })
  .strict();

/** `provider` and `id` cannot change: disable the connection and create a new one. */
export const ConnectionPatch = z
  .object({
    name: z.string().max(120).nullish(),
    enabled: z.boolean().nullish(),
    credentials: z.record(z.string(), z.string()).nullish(), // merged; "" removes a key
    webhook_secret: z.string().nullish(),
    settings: z.record(z.string(), z.unknown()).nullish(), // merged; null removes a key
  })
  .strict();

export const TestIn = z.object({
  to: z.string().regex(/^\+?[0-9 ()-]{8,20}$/),
  text: z.string().max(500).default("saybest: test message ✅"),
});

export interface ConnectionOut {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  credential_keys: string[];
  has_webhook_secret: boolean;
  webhook_url: string;
  missing: string[];
}

export function adminRouter(state: AppState): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const expected = state.settings.adminApiKey.value;
    if (!expected) return httpError(c, 503, "admin API disabled: set ADMIN_API_KEY");
    if (!safeEqual(c.req.header("x-api-key") ?? "", expected)) return httpError(c, 401);
    await next();
  });

  const out = (conn: ConnectionConfig): ConnectionOut => {
    const base = state.settings.publicBaseUrl.replace(/\/+$/, "");
    return {
      id: conn.id,
      name: conn.name,
      provider: conn.provider,
      enabled: conn.enabled,
      settings: conn.settings,
      credential_keys: Object.keys(conn.credentials).sort(),
      has_webhook_secret: Boolean(conn.webhook_secret.value),
      webhook_url: `${base}/webhooks/${conn.id}`,
      missing: missingFields(conn),
    };
  };

  const save = async (conn: ConnectionConfig): Promise<ConnectionOut> => {
    await state.connections.save(conn);
    state.pool.invalidate(conn.id);
    log.info("connection_saved", {
      connection_id: conn.id,
      provider: conn.provider,
      enabled: conn.enabled,
    });
    return out(conn);
  };

  /** The JSON body validated by `schema`, or a 422 response (like FastAPI). */
  async function body<T extends z.ZodType>(
    c: Context,
    schema: T,
  ): Promise<{ ok: true; value: z.infer<T> } | { ok: false; response: Response }> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, response: httpError(c, 422, "body must be JSON") };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => ({ loc: i.path, msg: i.message }));
      return { ok: false, response: c.json({ detail }, 422) };
    }
    return { ok: true, value: parsed.data };
  }

  app.get("/connections", async (c) => c.json((await state.connections.list()).map(out)));

  app.post("/connections", async (c) => {
    const parsed = await body(c, ConnectionIn);
    if (!parsed.ok) return parsed.response;
    const input = parsed.value;
    if ((await state.connections.get(input.id)) !== null) {
      return httpError(c, 409, `connection ${input.id} already exists`);
    }
    const conn = ConnectionConfig.parse(input);
    const missing = missingFields(conn);
    if (missing.length) return httpError(c, 422, `missing: ${missing.join(", ")}`);
    return c.json(await save(conn), 201);
  });

  app.get("/connections/:id", async (c) => {
    const conn = await state.connections.get(c.req.param("id"));
    return conn ? c.json(out(conn)) : httpError(c, 404);
  });

  app.patch("/connections/:id", async (c) => {
    const parsed = await body(c, ConnectionPatch);
    if (!parsed.ok) return parsed.response;
    const conn = await state.connections.get(c.req.param("id"));
    if (!conn) return httpError(c, 404);
    const patch = parsed.value;
    const credentials: Record<string, Secret> = { ...conn.credentials };
    for (const [key, value] of Object.entries(patch.credentials ?? {})) {
      if (value) credentials[key] = new Secret(value);
      else delete credentials[key];
    }
    const settings = Object.fromEntries(
      Object.entries({ ...conn.settings, ...(patch.settings ?? {}) }).filter(
        ([, v]) => v !== null && v !== undefined,
      ),
    );
    const updated: ConnectionConfig = {
      ...conn,
      name: patch.name ?? conn.name,
      enabled: patch.enabled ?? conn.enabled,
      credentials,
      webhook_secret:
        patch.webhook_secret !== null && patch.webhook_secret !== undefined
          ? new Secret(patch.webhook_secret)
          : conn.webhook_secret,
      settings,
    };
    const missing = missingFields(updated);
    if (missing.length) return httpError(c, 422, `missing: ${missing.join(", ")}`);
    return c.json(await save(updated));
  });

  for (const [action, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(`/connections/:id/${action}`, async (c) => {
      const conn = await state.connections.get(c.req.param("id"));
      if (!conn) return httpError(c, 404);
      return c.json(await save({ ...conn, enabled }));
    });
  }

  /** Send a real WhatsApp text through the connection (works even if disabled). */
  app.post("/connections/:id/test", async (c) => {
    const connectionId = c.req.param("id");
    const parsed = await body(c, TestIn);
    if (!parsed.ok) return parsed.response;
    const conn = await state.connections.get(connectionId);
    if (!conn) return httpError(c, 404);
    let channel: WhatsAppChannel;
    try {
      channel = buildChannel(conn, state.settings);
    } catch (exc) {
      return httpError(c, 422, exc instanceof Error ? exc.message : String(exc));
    }
    try {
      const messageId = await channel.sendText(parsed.value.to, parsed.value.text);
      return c.json({ ok: true, message_id: messageId });
    } catch (exc) {
      if (exc instanceof NotImplementedChannelError) return httpError(c, 501, exc.message);
      let error = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
      if (exc instanceof HttpStatusError) error += ` | ${exc.body.slice(0, 300)}`; // provider's reason (tokens are in headers)
      log.warning("connection_test_failed", {
        connection_id: connectionId,
        error: error.slice(0, 500),
      });
      return c.json({ ok: false, error: error.slice(0, 600) });
    } finally {
      await channel.close();
    }
  });

  return app;
}
