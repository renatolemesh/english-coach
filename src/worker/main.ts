/** Worker process: builds the runtime once, then consumes `process_message` jobs from BullMQ.
 * Concurrency 2 (3 CPUs; Whisper/Kokoro are CPU bound). SIGTERM: finish the running jobs and
 * close everything. */
import { Queue, Worker } from "bullmq";
import { getSettings } from "../config.js";
import { configureLogging, getLogger } from "../logging.js";
import { type JobName, QUEUE_NAME } from "./queue.js";
import { REMINDERS_EVERY_MS } from "./reminders.js";
import { buildRuntime } from "./runtime.js";
import { handleJob } from "./tasks.js";

const log = getLogger("coach.worker.main");
export const CONCURRENCY = 2;

async function main(): Promise<void> {
  const settings = getSettings();
  configureLogging(settings.logLevel);
  const runtime = await buildRuntime(settings);
  const worker = new Worker(
    QUEUE_NAME,
    (job) => handleJob(runtime, job.name as JobName, job.data),
    {
      connection: { url: settings.redisUrl, maxRetriesPerRequest: null },
      concurrency: CONCURRENCY,
    },
  );
  // one scheduler for all workers (BullMQ keeps a single repeatable job under this id)
  const scheduler = new Queue(QUEUE_NAME, {
    connection: { url: settings.redisUrl, maxRetriesPerRequest: null },
  });
  await scheduler.upsertJobScheduler(
    "reminders",
    { every: REMINDERS_EVERY_MS },
    { name: "reminders", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 } },
  );
  await scheduler.close();
  worker.on("failed", (job, err) =>
    log.error("job_failed", { job_id: job?.id, name: job?.name, error: String(err) }),
  );
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("worker_stopping", { signal });
    try {
      await worker.close(); // waits for the jobs in progress
      await runtime.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  log.info("worker_started", { queue: QUEUE_NAME, concurrency: CONCURRENCY });
}

main().catch((exc) => {
  log.exception("worker_crashed", exc);
  process.exit(1);
});
