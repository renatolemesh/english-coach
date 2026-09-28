/** The API with in-memory state. */
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { createApp } from "../../src/api/app.js";
import type { AppState } from "../../src/api/deps.js";
import { loadSettings, type Settings } from "../../src/config.js";
import { MemoryEventLog } from "../../src/connections/events.js";
import { ChannelPool } from "../../src/connections/pool.js";
import { MemoryConnectionStore } from "../../src/connections/store.js";
import type { ConnectionConfig } from "../../src/domain/connections.js";
import { MemoryTaskQueue } from "../../src/worker/queue.js";
import { evoConn, metaConn } from "../channels/helpers.js";

export function testSettings(over: Partial<Record<keyof Settings, unknown>> = {}): Settings {
  return loadSettings({}, { env: "test", useFakes: true, ...over });
}

export interface Client {
  request(path: string, init?: RequestInit): Promise<Response>;
  state: AppState;
  store: MemoryConnectionStore;
  events: MemoryEventLog;
  queue: MemoryTaskQueue;
}

export function makeClient(conns: ConnectionConfig[] = [evoConn(), metaConn()]): Client {
  const settings = testSettings({
    adminApiKey: "admin-key",
    publicBaseUrl: "https://saybest.example",
  });
  const store = new MemoryConnectionStore(...conns);
  const events = new MemoryEventLog();
  const queue = new MemoryTaskQueue();
  const state: AppState = {
    settings,
    cache: new MemoryCache(),
    connections: store,
    pool: new ChannelPool(store, settings),
    events,
    queue,
  };
  const app = createApp(state);
  return {
    request: async (path, init) => app.request(path, init),
    state,
    store,
    events,
    queue,
  };
}
