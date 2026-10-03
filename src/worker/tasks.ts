/**
 * Worker tasks. `processMessage` runs one inbound WhatsApp message through the graph.
 *
 * Exactly-once-ish delivery: each webhook_events row is claimed atomically (queued ->
 * processing) before the graph runs, so a stalled-job redelivery or a duplicate job is
 * skipped. There is no automatic retry after the graph started (it may already have sent the
 * image); failures are recorded on the row (status=failed).
 */

import { APP_CONNECTION } from "../adapters/channels/app.js";
import type { EventLogPort } from "../connections/events.js";
import type { PoolEntry } from "../connections/pool.js";
import type { Container } from "../container.js";
import { IncomingMessage } from "../domain/messages.js";
import type { ConversationRunner } from "../graph/runner.js";
import { getLogger } from "../logging.js";
import { PanelQueries } from "../panel/queries.js";
import { LockTimeoutError } from "../ports/cache.js";
import type { ChatChannel } from "../ports/channel.js";
import type { JobName, ProcessMessageJob, TaskQueue } from "./queue.js";
import { type ReminderDeps, sendReminders } from "./reminders.js";

const log = getLogger("coach.worker.tasks");
export const MAX_LOCK_ATTEMPTS = 10; // x THREAD_LOCK_WAIT_S: how long a message may wait for its thread
export const REQUEUE_DELAY_S = 2.0;
const MEDIA_KEEP_MS = 7 * 86_400_000;

/** Everything a task needs (built once per worker process, worker/runtime.ts). */
export interface WorkerRuntime {
  container: Container;
  runner: ConversationRunner;
  pool: { get(connectionId: string): Promise<PoolEntry> };
  app?: ChatChannel; // the app's channel (connection "app" has no row in connections)
  events: EventLogPort;
  queue: TaskQueue; // to requeue a message whose thread is busy
  close(): Promise<void>;
}

export type TaskResult =
  | "processed"
  | "duplicate"
  | "connection_unavailable"
  | "requeued"
  | "failed";

/** The channel of a connection id: the app's, or a configured one from the pool. */
async function channelOf(rt: WorkerRuntime, connectionId: string): Promise<ChatChannel | null> {
  if (connectionId === APP_CONNECTION) return rt.app ?? null;
  return (await rt.pool.get(connectionId))?.[1] ?? null;
}

export async function ping(): Promise<string> {
  return "pong";
}

export async function processMessage(
  rt: WorkerRuntime,
  connectionId: string,
  message: Record<string, unknown>,
  eventId: number,
  attempt = 0,
): Promise<TaskResult> {
  if (!(await rt.events.claim(eventId))) {
    log.info("process_message_skipped", { event_id: eventId, reason: "already claimed" });
    return "duplicate";
  }
  const settings = rt.container.settings;
  try {
    const msg = IncomingMessage.parse(message);
    const channel = await channelOf(rt, connectionId);
    if (!channel) {
      await rt.events.mark(eventId, "failed", "connection unavailable");
      return "connection_unavailable";
    }
    // Messages of one conversation never run concurrently (they share a checkpoint).
    await rt.container.cache.withLock(
      `thread:${connectionId}:${msg.from}`, // one sender's messages in order
      settings.threadLockTimeoutS,
      settings.threadLockWaitS,
      async () => {
        const config = await rt.container.runtime.get(); // panel settings (cached ~30 s)
        await rt.runner.handle(msg, connectionId, rt.container.graphContext(channel, config));
      },
    );
  } catch (exc) {
    if (exc instanceof LockTimeoutError) {
      // The student's previous message is still being processed: give the slot back and
      // retry later instead of blocking one of the few worker slots.
      if (attempt + 1 < MAX_LOCK_ATTEMPTS) {
        await rt.events.mark(eventId, "queued");
        const job: ProcessMessageJob = {
          connection_id: connectionId,
          message,
          event_id: eventId,
          attempt: attempt + 1,
        };
        await rt.queue.add("process_message", job, { delayMs: REQUEUE_DELAY_S * 1000 });
        return "requeued";
      }
      await rt.events.mark(eventId, "failed", "thread busy");
      return "failed";
    }
    log.exception("process_message_failed", exc, {
      connection_id: connectionId,
      event_id: eventId,
    });
    const error = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    await rt.events.mark(eventId, "failed", error);
    return "failed";
  }
  await rt.events.mark(eventId, "processed");
  return "processed";
}

/** What the reminders need, from the worker's runtime. */
export async function reminderDeps(rt: WorkerRuntime): Promise<ReminderDeps> {
  const { container } = rt;
  const config = await container.runtime.get();
  const database = container.database;
  const queries = database ? new PanelQueries(database.db, config.timezone) : null;
  return {
    repo: container.repo,
    config,
    channelFor: (id) => channelOf(rt, id),
    streakOf: async (userId, goal, level) =>
      queries ? (await queries.progress(userId, goal, level)).streak : 0,
    dueReviews: async (userId, now) => (await container.courseRepo.stats(userId, now)).due,
  };
}

/** The queue's processor: job name -> task. */
export async function handleJob(rt: WorkerRuntime, name: JobName, data: unknown): Promise<string> {
  if (name === "ping") return ping();
  if (name === "reminders") {
    // housekeeping rides on the same schedule: app audio older than a week goes
    await rt.container.appStore.purgeMedia(new Date(Date.now() - MEDIA_KEEP_MS));
    return `sent ${await sendReminders(await reminderDeps(rt))}`;
  }
  const job = data as ProcessMessageJob;
  return processMessage(rt, job.connection_id, job.message, job.event_id, job.attempt ?? 0);
}
