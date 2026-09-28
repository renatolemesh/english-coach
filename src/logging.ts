/**
 * Structured JSON logs (pino), one object per line: `event`, `logger`,
 * `level`, `timestamp`, plus context bound per message (user_id, connection_id, thread_id).
 * Usage: `const log = getLogger("coach.graph"); log.info("turn_done", { score: 80 })`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

type Fields = Record<string, unknown>;

// Meta's webhook verification sends hub.verify_token in the query string.
const SECRET_QUERY_RE = /(hub[._]verify_token=)[^&\s"]*/g;

export function redactSecrets(text: string): string {
  return text.includes("verify_token") ? text.replace(SECRET_QUERY_RE, "$1***") : text;
}

const context = new AsyncLocalStorage<Fields>();

let root = pino({
  level: process.env.LOG_LEVEL?.toLowerCase() ?? "info",
  base: undefined,
  messageKey: "event",
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label === "warn" ? "warning" : label }) },
});

export function configureLogging(level: string): void {
  root.level = level.toLowerCase() === "warning" ? "warn" : level.toLowerCase();
}

/** Silence logs (tests). */
export function setLogDestination(stream: pino.DestinationStream): void {
  root = pino({ level: root.level, base: undefined, messageKey: "event" }, stream);
}

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warning(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Error with its stack trace (`exc` is an Error or anything thrown). */
  exception(event: string, exc: unknown, fields?: Fields): void;
}

export function getLogger(name: string): Logger {
  const emit = (level: pino.Level, event: string, fields: Fields = {}) => {
    root[level]({ logger: name, ...(context.getStore() ?? {}), ...fields }, redactSecrets(event));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warning: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    exception: (e, exc, f) =>
      emit("error", e, {
        ...f,
        error: exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc),
        stack: exc instanceof Error ? exc.stack : undefined,
      }),
  };
}

/** Run `fn` with fields bound to every log line inside it (one message = one context). */
export function withContext<T>(fields: Fields, fn: () => Promise<T>): Promise<T> {
  return context.run({ ...(context.getStore() ?? {}), ...fields }, fn);
}

const nodeLog = getLogger("coach.node");

/** Log `node_done` with latency_ms (or `node_failed`) around `fn`. */
export async function logLatency<T>(node: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    nodeLog.info("node_done", {
      node,
      latency_ms: Math.round((performance.now() - start) * 10) / 10,
    });
    return result;
  } catch (exc) {
    const ms = Math.round((performance.now() - start) * 10) / 10;
    nodeLog.exception("node_failed", exc, { node, latency_ms: ms });
    throw exc;
  }
}
