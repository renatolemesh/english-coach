/**
 * POST/GET /webhooks/:connectionId: validate, record, enqueue, answer 200 immediately.
 *
 * Providers redeliver webhooks (Evolution retries up to 10x when a response takes >30 s), so each
 * message id is claimed once in Redis (SETNX + TTL) before it is queued.
 */
import { type Context, Hono } from "hono";
import { NotImplementedChannelError } from "../adapters/channels/stub.js";
import type { PoolEntry } from "../connections/pool.js";
import type { IncomingMessage } from "../domain/messages.js";
import { getLogger } from "../logging.js";
import type { Headers } from "../ports/channel.js";
import type { AppState } from "./deps.js";
import { httpError } from "./errors.js";

const log = getLogger("coach.api.webhooks");
const ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;

class BodyTooLargeError extends Error {}

/** Reject by Content-Length first, then stream with a hard cap (chunked uploads). */
async function readBody(req: Request, limit: number): Promise<Buffer> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new BodyTooLargeError();
  }
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const headersOf = (req: Request): Headers => Object.fromEntries(req.headers.entries());

/** The message as queued: JSON, without `raw` (it is in webhook_events). */
export function messageJson(msg: IncomingMessage): Record<string, unknown> {
  const { raw: _raw, timestamp, ...rest } = msg;
  return { ...rest, timestamp: timestamp.toISOString() };
}

export function webhooksRouter(state: AppState): Hono {
  const app = new Hono();

  async function channelFor(id: string): Promise<PoolEntry> {
    if (!ID_RE.test(id)) return null;
    return state.pool.get(id);
  }

  /** Meta's subscription handshake (hub.mode / hub.verify_token / hub.challenge). */
  app.get("/:connectionId", async (c) => {
    const found = await channelFor(c.req.param("connectionId"));
    if (!found) return httpError(c, 404);
    let result: boolean | string;
    try {
      result = found[1].verifyWebhook(headersOf(c.req.raw), Buffer.alloc(0), c.req.query());
    } catch (exc) {
      if (exc instanceof NotImplementedChannelError) return httpError(c, 501);
      throw exc;
    }
    if (typeof result === "string" && result) return c.text(result);
    return httpError(c, 403);
  });

  app.post("/:connectionId", async (c) => receive(c, c.req.param("connectionId")));

  async function receive(c: Context, connectionId: string): Promise<Response> {
    const found = await channelFor(connectionId);
    if (!found) return httpError(c, 404);
    const [conn, channel] = found;
    let body: Buffer;
    try {
      body = await readBody(c.req.raw, state.settings.webhookMaxBodyBytes);
    } catch (exc) {
      if (exc instanceof BodyTooLargeError) return httpError(c, 413);
      throw exc;
    }
    const headers = headersOf(c.req.raw);
    let verified: boolean | string;
    try {
      verified = channel.verifyWebhook(headers, body, c.req.query());
    } catch (exc) {
      if (exc instanceof NotImplementedChannelError) return httpError(c, 501); // WAHA / Z-API stubs
      throw exc;
    }
    if (verified !== true) {
      log.warning("webhook_rejected", { connection_id: connectionId, reason: "auth" });
      return httpError(c, 401);
    }
    let messages: IncomingMessage[];
    try {
      messages = channel.parseWebhook(headers, body);
    } catch (exc) {
      log.warning("webhook_unparseable", { connection_id: connectionId, error: String(exc) });
      return httpError(c, 400);
    }

    let queued = 0;
    for (const msg of messages) {
      const key = `wh:${connectionId}:${msg.id}`;
      const ttl = state.settings.webhookIdempotencyTtlS;
      if (!(await state.cache.setIfAbsent(key, Buffer.from("1"), ttl))) {
        log.info("webhook_duplicate", { connection_id: connectionId, message_id: msg.id });
        continue;
      }
      let eventId: number | null = null;
      try {
        eventId = await state.events.record(connectionId, msg.id, msg.raw);
        await state.queue.add("process_message", {
          connection_id: conn.id,
          message: messageJson(msg),
          event_id: eventId,
          attempt: 0,
        });
      } catch (exc) {
        log.exception("webhook_enqueue_failed", exc, { connection_id: connectionId });
        await release(key, eventId);
        return httpError(c, 503);
      }
      queued += 1;
    }
    log.info("webhook_received", {
      connection_id: connectionId,
      messages: messages.length,
      queued,
    });
    return c.json({ received: messages.length, queued });
  }

  /** Undo the claim so the provider's retry can deliver the message again. */
  async function release(key: string, eventId: number | null): Promise<void> {
    try {
      if (eventId !== null) await state.events.mark(eventId, "failed", "enqueue failed");
      await state.cache.delete(key);
    } catch (exc) {
      log.exception("webhook_release_failed", exc, { key });
    }
  }

  return app;
}
