/** The job queue between the API and the worker: BullMQ on Redis (in memory for tests). */
import { Queue } from "bullmq";

export const QUEUE_NAME = "process_message";
export type JobName = "process_message" | "ping" | "reminders";

/** One inbound message to run through the graph (the webhook_events row is `event_id`). */
export interface ProcessMessageJob {
  connection_id: string;
  message: Record<string, unknown>; // IncomingMessage as JSON, without `raw`
  event_id: number;
  attempt: number;
}

export interface TaskQueue {
  add(name: "process_message", data: ProcessMessageJob, opts?: { delayMs?: number }): Promise<void>;
  add(name: "ping", data: Record<string, never>, opts?: { delayMs?: number }): Promise<void>;
  close(): Promise<void>;
}

export class BullTaskQueue implements TaskQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.queue = new Queue(QUEUE_NAME, { connection: { url: redisUrl } });
  }

  async add(name: JobName, data: object, opts: { delayMs?: number } = {}): Promise<void> {
    // attempts: 1 -> no automatic retry after the graph started (it may already have sent the
    // image); stalled jobs (worker crash) are redelivered and skipped by the event claim.
    await this.queue.add(name, data, {
      attempts: 1,
      delay: opts.delayMs ?? 0,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface QueuedJob {
  name: JobName;
  data: unknown;
  delayMs: number;
}

/** In-memory queue (tests): records jobs; `drain` runs them through a processor. */
export class MemoryTaskQueue implements TaskQueue {
  readonly jobs: QueuedJob[] = [];
  failWith: Error | null = null; // simulate Redis down

  async add(name: JobName, data: unknown, opts: { delayMs?: number } = {}): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.jobs.push({ name, data, delayMs: opts.delayMs ?? 0 });
  }

  async drain(processor: (name: JobName, data: unknown) => Promise<unknown>): Promise<unknown[]> {
    const results: unknown[] = [];
    while (this.jobs.length) {
      const job = this.jobs.shift() as QueuedJob;
      results.push(await processor(job.name, job.data));
    }
    return results;
  }

  async close(): Promise<void> {}
}
