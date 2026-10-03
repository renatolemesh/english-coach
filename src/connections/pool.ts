/**
 * connection id -> (config, channel adapter).
 *
 * - Channels (and their HTTP clients) are reused while the config is unchanged; the config is
 *   re-read every `ttlS` so admin edits take effect quickly.
 * - A replaced channel is NOT closed immediately (a turn in flight may still be sending with it);
 *   it is retired and closed after `graceS`, or at shutdown.
 * - Unknown/disabled ids are cached as misses for `ttlS`, so random ids cannot hammer Postgres.
 */
import { buildChannel } from "../adapters/channels/registry.js";
import type { Settings } from "../config.js";
import type { ConnectionConfig } from "../domain/connections.js";
import { getLogger } from "../logging.js";
import type { ChatChannel } from "../ports/channel.js";
import type { ConnectionStorePort } from "./store.js";

const log = getLogger("coach.connections.pool");

export type PoolEntry = readonly [ConnectionConfig, ChatChannel] | null;

function fingerprint(conn: ConnectionConfig): string {
  const credentials = Object.fromEntries(
    Object.entries(conn.credentials).map(([k, v]) => [k, v.value]),
  );
  return JSON.stringify([
    { ...conn, credentials: undefined, webhook_secret: undefined },
    credentials,
    conn.webhook_secret.value,
  ]);
}

const now = () => performance.now() / 1000;

export class ChannelPool {
  private readonly cache = new Map<string, [number, string, PoolEntry]>();
  private retired: [number, ChatChannel][] = [];

  constructor(
    readonly store: ConnectionStorePort,
    private readonly settings: Settings,
    private readonly ttlS = 30.0,
    private readonly graceS = 600.0,
  ) {}

  /** Enabled connection and its channel, or null (unknown/disabled/misconfigured). */
  async get(connectionId: string): Promise<PoolEntry> {
    const t = now();
    const cached = this.cache.get(connectionId);
    if (cached && t - cached[0] < this.ttlS) return cached[2];
    await this.closeRetired(t);
    const conn = await this.store.get(connectionId);
    let entry: PoolEntry = null;
    let print = "";
    if (conn?.enabled) {
      print = fingerprint(conn);
      if (cached && cached[1] === print && cached[2] !== null) {
        entry = [conn, cached[2][1]]; // unchanged: keep the same channel/client
      } else entry = this.build(conn);
    }
    if (cached?.[2] && (entry === null || entry[1] !== cached[2][1])) {
      this.retired.push([t, cached[2][1]]);
    }
    this.cache.set(connectionId, [t, print, entry]);
    return entry;
  }

  private build(conn: ConnectionConfig): PoolEntry {
    try {
      return [conn, buildChannel(conn, this.settings)];
    } catch (exc) {
      log.warning("connection_misconfigured", { connection_id: conn.id, error: String(exc) });
      return null;
    }
  }

  invalidate(connectionId: string): void {
    const cached = this.cache.get(connectionId);
    this.cache.delete(connectionId);
    if (cached?.[2]) this.retired.push([now(), cached[2][1]]);
  }

  private async closeRetired(t: number): Promise<void> {
    const keep: [number, ChatChannel][] = [];
    for (const [retiredAt, channel] of this.retired) {
      if (t - retiredAt >= this.graceS) await channel.close();
      else keep.push([retiredAt, channel]);
    }
    this.retired = keep;
  }

  async close(): Promise<void> {
    for (const [, , entry] of this.cache.values()) if (entry) await entry[1].close();
    for (const [, channel] of this.retired) await channel.close();
    this.cache.clear();
    this.retired = [];
  }
}
