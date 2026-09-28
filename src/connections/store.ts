/** CRUD for channel_connections (credentials and webhook secret encrypted at rest). */
import { asc, eq, sql } from "drizzle-orm";
import { Secret } from "../config.js";
import type { Db } from "../db/client.js";
import { channelConnections } from "../db/schema.js";
import { ConnectionConfig } from "../domain/connections.js";
import type { CredentialCipher } from "./crypto.js";

export interface ConnectionStorePort {
  get(connectionId: string): Promise<ConnectionConfig | null>;
  list(): Promise<ConnectionConfig[]>;
  save(conn: ConnectionConfig): Promise<void>;
  setEnabled(connectionId: string, enabled: boolean): Promise<boolean>;
}

type Row = typeof channelConnections.$inferSelect;

export class ConnectionStore implements ConnectionStorePort {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
  ) {}

  private toConfig(row: Row): ConnectionConfig {
    const secret = this.cipher.decrypt(row.webhookSecret).value;
    return ConnectionConfig.parse({
      id: row.id,
      name: row.name,
      provider: row.provider,
      enabled: row.enabled,
      credentials: this.cipher.decrypt(row.credentials),
      webhook_secret: secret ?? new Secret(""),
      settings: row.settings ?? {},
    });
  }

  async get(connectionId: string): Promise<ConnectionConfig | null> {
    const [row] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connectionId));
    return row ? this.toConfig(row) : null;
  }

  async list(): Promise<ConnectionConfig[]> {
    const rows = await this.db
      .select()
      .from(channelConnections)
      .orderBy(asc(channelConnections.id));
    return rows.map((r) => this.toConfig(r));
  }

  async save(conn: ConnectionConfig): Promise<void> {
    const values = {
      name: conn.name,
      provider: conn.provider,
      enabled: conn.enabled,
      credentials: this.cipher.encrypt(conn.credentials),
      webhookSecret: this.cipher.encrypt({ value: conn.webhook_secret }),
      settings: conn.settings,
    };
    await this.db
      .insert(channelConnections)
      .values({ id: conn.id, ...values })
      .onConflictDoUpdate({
        target: channelConnections.id,
        set: { ...values, updatedAt: sql`now()` },
      });
  }

  async setEnabled(connectionId: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(channelConnections)
      .set({ enabled })
      .where(eq(channelConnections.id, connectionId))
      .returning({ id: channelConnections.id });
    return rows.length > 0;
  }
}

/** In-memory store (tests): counts `get` calls to prove the pool caches. */
export class MemoryConnectionStore implements ConnectionStorePort {
  readonly conns = new Map<string, ConnectionConfig>();
  gets = 0;

  constructor(...conns: ConnectionConfig[]) {
    for (const c of conns) this.conns.set(c.id, c);
  }

  async get(connectionId: string): Promise<ConnectionConfig | null> {
    this.gets += 1;
    return this.conns.get(connectionId) ?? null;
  }

  async list(): Promise<ConnectionConfig[]> {
    return [...this.conns.values()];
  }

  async save(conn: ConnectionConfig): Promise<void> {
    this.conns.set(conn.id, conn);
  }

  async setEnabled(connectionId: string, enabled: boolean): Promise<boolean> {
    const conn = this.conns.get(connectionId);
    if (!conn) return false;
    this.conns.set(connectionId, { ...conn, enabled });
    return true;
  }
}
