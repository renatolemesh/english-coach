/** Objects the API keeps for its lifetime (built once in app.buildState; injectable in tests). */
import type { Settings } from "../config.js";
import type { EventLogPort } from "../connections/events.js";
import type { ChannelPool } from "../connections/pool.js";
import type { ConnectionStorePort } from "../connections/store.js";
import type { Database } from "../db/client.js";
import type { Cache } from "../ports/cache.js";
import type { TaskQueue } from "../worker/queue.js";

export interface AppState {
  settings: Settings;
  cache: Cache;
  connections: ConnectionStorePort;
  pool: ChannelPool;
  events: EventLogPort;
  queue: TaskQueue;
  db?: Database | null; // the panel needs it (null in tests)
}
