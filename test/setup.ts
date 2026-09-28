// Tests: no .env, fakes everywhere, quiet logs, and never the internet (a mis-wired mock
// would bill OpenRouter). Integration tests talk to 127.0.0.1 only.
import { Writable } from "node:stream";
import { setLogDestination } from "../src/logging.js";

process.env.ENV = "test";
process.env.USE_FAKES = "true";
setLogDestination(new Writable({ write: (_c, _e, cb) => cb() }));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error(`network blocked in tests: ${url.hostname}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
