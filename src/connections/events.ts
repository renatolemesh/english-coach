/** webhook_events rows: every accepted inbound message is stored before it is queued. */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { webhookEvents } from "../db/schema.js";

export type EventStatus = "queued" | "processing" | "processed" | "failed";

export interface EventLogPort {
  record(
    connectionId: string,
    messageId: string,
    payload: Record<string, unknown>,
  ): Promise<number>;
  /** queued -> processing, atomically. False if another delivery already took it. */
  claim(eventId: number): Promise<boolean>;
  mark(eventId: number, status: EventStatus, error?: string | null): Promise<void>;
}

export class EventLog implements EventLogPort {
  constructor(private readonly db: Db) {}

  async record(
    connectionId: string,
    messageId: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const [row] = await this.db
      .insert(webhookEvents)
      .values({ connectionId, messageId, payload, status: "queued" })
      .returning({ id: webhookEvents.id });
    if (!row) throw new Error("webhook_events insert returned nothing");
    return row.id;
  }

  /** queued -> processing, atomically. False if another delivery already took it
   * (BullMQ redelivers stalled jobs; a worker crash also redelivers). */
  async claim(eventId: number): Promise<boolean> {
    const rows = await this.db
      .update(webhookEvents)
      .set({ status: "processing" })
      .where(and(eq(webhookEvents.id, eventId), eq(webhookEvents.status, "queued")))
      .returning({ id: webhookEvents.id });
    return rows.length > 0;
  }

  async mark(eventId: number, status: EventStatus, error: string | null = null): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ status, error: error ? error.slice(0, 2000) : null })
      .where(eq(webhookEvents.id, eventId));
  }
}

/** In-memory EventLog (tests): same claim semantics, records what happened. */
export class MemoryEventLog implements EventLogPort {
  readonly recorded: [string, string][] = [];
  readonly marks: [number, string, string | null][] = [];
  readonly claimed = new Set<number>();

  async record(connectionId: string, messageId: string): Promise<number> {
    this.recorded.push([connectionId, messageId]);
    return this.recorded.length;
  }

  async claim(eventId: number): Promise<boolean> {
    if (this.claimed.has(eventId)) return false;
    this.claimed.add(eventId);
    return true;
  }

  async mark(eventId: number, status: EventStatus, error: string | null = null): Promise<void> {
    if (status === "queued") this.claimed.delete(eventId);
    this.marks.push([eventId, status, error]);
  }
}
