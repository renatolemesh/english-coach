/** Shared by the channel, connection, webhook and admin tests. */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { PROJECT_ROOT } from "../../src/config.js";
import { ConnectionConfig, type ConnectionInput } from "../../src/domain/connections.js";

export const FIXTURES = path.join(PROJECT_ROOT, "test", "fixtures");

export const fixture = (name: string): Buffer => readFileSync(path.join(FIXTURES, name));

export function metaConn(overrides: Partial<ConnectionInput> = {}): ConnectionConfig {
  return ConnectionConfig.parse({
    id: "meta-main",
    name: "Meta",
    provider: "meta",
    credentials: { access_token: "EAAG-token", app_secret: "s3cret", verify_token: "verify-me" },
    settings: { phone_number_id: "106540352242922" },
    ...overrides,
  });
}

export function evoConn(overrides: Partial<ConnectionInput> = {}): ConnectionConfig {
  return ConnectionConfig.parse({
    id: "evo-main",
    name: "Evolution",
    provider: "evolution",
    credentials: { api_key: "evo-key" },
    webhook_secret: "hook-secret",
    settings: { base_url: "http://evolution.test", instance: "coach" },
    ...overrides,
  });
}

export const metaSignature = (body: Buffer, secret = "s3cret") =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// --- fetch interception (the respx of these tests) -------------------------------------------

type Responder = Response | ((req: Request) => Response | Promise<Response>);

export class Route {
  readonly calls: Request[] = [];
  private queue: Responder[] = [];
  private fallback: Responder = () => new Response(null, { status: 200 });

  constructor(
    readonly method: string,
    readonly url: string,
  ) {}

  /** Always answer with this (status + JSON body, or raw bytes). */
  respond(status: number, body?: unknown): this {
    this.queue = [];
    this.fallback = () => jsonOrBytes(status, body);
    return this;
  }

  /** Answer the next calls with these, in order (like respx side_effect). */
  sequence(...responses: [number, unknown?][]): this {
    this.queue = responses.map(
      ([s, b]) =>
        () =>
          jsonOrBytes(s, b),
    );
    return this;
  }

  get called(): boolean {
    return this.calls.length > 0;
  }

  get last(): Request {
    const req = this.calls.at(-1);
    if (!req) throw new Error(`${this.method} ${this.url} was not called`);
    return req;
  }

  async handle(req: Request): Promise<Response> {
    this.calls.push(req.clone());
    const next = this.queue.shift() ?? this.fallback;
    return typeof next === "function" ? next(req) : next;
  }
}

function jsonOrBytes(status: number, body: unknown): Response {
  if (body instanceof Uint8Array) return new Response(new Uint8Array(body), { status });
  if (body === undefined) return new Response(null, { status });
  return Response.json(body, { status });
}

/** Replace global fetch with a router over `Route`s; anything else fails the test. */
export class FetchMock {
  readonly routes: Route[] = [];

  constructor() {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const route = this.routes.find((r) => r.method === req.method && r.url === req.url);
      if (!route) return Promise.reject(new TypeError(`unmocked ${req.method} ${req.url}`));
      return route.handle(req);
    });
  }

  route(method: string, url: string): Route {
    const route = new Route(method, url);
    this.routes.push(route);
    return route;
  }

  post(url: string): Route {
    return this.route("POST", url);
  }

  get(url: string): Route {
    return this.route("GET", url);
  }
}
