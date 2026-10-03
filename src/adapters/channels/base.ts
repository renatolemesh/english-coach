/** Shared HTTP plumbing for channel adapters: timeouts, retry with backoff on transient
 * failures (429/5xx/network), bounded downloads, phone normalization and secret redaction. */
import { createHash, timingSafeEqual } from "node:crypto";
import { getLogger } from "../../logging.js";

const log = getLogger("coach.adapters.channels.base");
export const TIMEOUT_MS = 20_000;
const MAX_WAIT_S = 10;

export class ChannelError extends Error {
  override name = "ChannelError";
}

export class MediaTooLargeError extends ChannelError {
  override name = "MediaTooLargeError";
}

/** A non-2xx answer from the provider (like httpx.HTTPStatusError). */
export class HttpStatusError extends Error {
  override name = "HttpStatusError";
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Network failure or timeout (like httpx.TransportError): always retried. */
export class TransportError extends Error {
  override name = "TransportError";
}

export const digits = (phone: string): string => phone.replace(/\D/g, "");

/** Constant-time string comparison (works with any characters; never throws). */
export function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Replace every secret value found in `text` by *** (error messages, logs). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

// An integer written as text: an optional sign and digits, surrounding whitespace allowed.
const INT_RE = /^\s*[+-]?\d+\s*$/;

function toInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && INT_RE.test(value)) return Number(value.trim());
  return null;
}

function protobufLong(value: Record<string, unknown>): number | null {
  const high = toInt(value.high ?? 0);
  const low = toInt(value.low ?? 0);
  if (high === null || low === null) return null;
  return high * 2 ** 32 + (low >>> 0);
}

/** Provider timestamps: int, numeric string, or protobuf Long {"low", "high"}; else now. */
export function parseEpoch(value: unknown): Date {
  const seconds =
    value !== null && typeof value === "object"
      ? protobufLong(value as Record<string, unknown>)
      : toInt(value);
  if (seconds === null) return new Date();
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function parseSize(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return protobufLong(value as Record<string, unknown>);
  return toInt(value);
}

const transient = (exc: unknown): boolean =>
  exc instanceof TransportError ||
  (exc instanceof HttpStatusError && (exc.status === 429 || exc.status >= 500));

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One client per adapter; retries only transient errors (never 4xx). */
export class HttpClient {
  closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly attempts = 3,
    public wait = 1.0, // initial backoff in seconds (0 in tests)
    private readonly urlSecrets: readonly string[] = [], // Telegram: the token is in the path
  ) {}

  private get secrets(): string[] {
    return [...Object.values(this.headers), ...this.urlSecrets];
  }

  private url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
  }

  // Error messages never carry the provider path's query nor our tokens.
  private describe(method: string, url: string): string {
    return redact(`${method} ${url.split("?")[0]}`, this.secrets);
  }

  private async fetchOnce(method: string, url: string, opts: RequestOptions): Promise<Response> {
    if (this.closed) throw new ChannelError("HTTP client is closed");
    const headers: Record<string, string> = { ...this.headers };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (exc) {
      const reason = exc instanceof Error ? exc.message : String(exc);
      throw new TransportError(`${this.describe(method, url)}: ${redact(reason, this.secrets)}`);
    }
    if (!response.ok) {
      const text = redact(await response.text().catch(() => ""), this.secrets);
      const kind = response.status >= 500 ? "Server error" : "Client error";
      throw new HttpStatusError(
        response.status,
        `${kind} '${response.status} ${response.statusText}' for ${this.describe(method, url)}`,
        text,
      );
    }
    return response;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = this.url(path);
    for (let n = 1; ; n++) {
      if (n > 1)
        log.warning("channel_retry", {
          url: redact(url.split("?")[0] ?? "", this.secrets),
          attempt: n,
        });
      try {
        return await this.fetchOnce(method, url, opts);
      } catch (exc) {
        if (!transient(exc) || n >= this.attempts) throw exc;
        const waitS = Math.min(this.wait * 2 ** (n - 1) + Math.random() * this.wait, MAX_WAIT_S);
        await sleep(waitS * 1000);
      }
    }
  }

  /** Read a response body, aborting as soon as it exceeds maxBytes. */
  private async readBounded(response: Response, maxBytes: number, what: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MediaTooLargeError(`${what}> ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** GET a file, aborting as soon as it exceeds maxBytes. */
  async download(url: string, maxBytes: number): Promise<[Buffer, string]> {
    const response = await this.fetchOnce("GET", this.url(url), {});
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new MediaTooLargeError(`${declared} bytes > ${maxBytes}`);
    }
    const data = await this.readBounded(response, maxBytes, "");
    return [data, response.headers.get("content-type") ?? ""];
  }

  /** POST and parse a JSON response, aborting if the response exceeds maxBytes. */
  async postJsonBounded(path: string, body: unknown, maxBytes: number): Promise<unknown> {
    const response = await this.fetchOnce("POST", this.url(path), { json: body });
    const data = await this.readBounded(response, maxBytes, "response ");
    return JSON.parse(data.toString("utf8"));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A plain object or null (JSON payloads from providers are untrusted). */
export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
