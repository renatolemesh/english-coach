/** Everything a worker process needs, built ONCE at startup: container with media (models
 * loaded, browser started), Postgres checkpointer, graph runner, channel pool, event log. */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type pg from "pg";
import { FfmpegAudio } from "../adapters/audio/ffmpeg.js";
import { AppChannel } from "../adapters/channels/app.js";
import type { Settings } from "../config.js";
import { CredentialCipher } from "../connections/crypto.js";
import { EventLog } from "../connections/events.js";
import { ChannelPool } from "../connections/pool.js";
import { ConnectionStore } from "../connections/store.js";
import { buildContainer, type MediaFactory } from "../container.js";
import { ConversationRunner } from "../graph/runner.js";
import { getLogger } from "../logging.js";
import { BullTaskQueue, type TaskQueue } from "./queue.js";
import type { WorkerRuntime } from "./tasks.js";

const log = getLogger("coach.worker.runtime");
// LangGraph.js checkpoints live in their own schema (lg_ts); checkpoints elsewhere are not read.
export const CHECKPOINT_SCHEMA = "lg_ts";

/** The real media adapters, imported lazily (whisper/kokoro/playwright load only in the worker). */
export const defaultMediaFactory: MediaFactory = async (settings, cache) => {
  const { buildMedia } = await import("../adapters/media.js");
  return buildMedia(settings, cache);
};

/**
 * Keep only the latest checkpoint per thread (we never time-travel; history lives in `turns`).
 * PostgresSaver has no prune, so this deletes with the saver's own schema: older rows in
 * `checkpoints` / `checkpoint_writes`, and `checkpoint_blobs` whose (channel, version) is not
 * referenced by the kept checkpoint's `channel_versions`. Checkpoint ids are uuid6
 * (time-ordered), so max() is the latest one.
 */
export function checkpointPruner(pool: pg.Pool, schema = CHECKPOINT_SCHEMA) {
  const s = `"${schema}"`;
  const latest = `WITH latest AS (
      SELECT checkpoint_ns, max(checkpoint_id) AS checkpoint_id
      FROM ${s}.checkpoints WHERE thread_id = $1 GROUP BY checkpoint_ns
    )`;
  const statements = [
    `${latest} DELETE FROM ${s}.checkpoint_writes w USING latest l
     WHERE w.thread_id = $1 AND w.checkpoint_ns = l.checkpoint_ns
       AND w.checkpoint_id <> l.checkpoint_id`,
    `${latest} DELETE FROM ${s}.checkpoints c USING latest l
     WHERE c.thread_id = $1 AND c.checkpoint_ns = l.checkpoint_ns
       AND c.checkpoint_id <> l.checkpoint_id`,
    `DELETE FROM ${s}.checkpoint_blobs b
     WHERE b.thread_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM ${s}.checkpoints c
         WHERE c.thread_id = b.thread_id AND c.checkpoint_ns = b.checkpoint_ns
           AND c.checkpoint -> 'channel_versions' ->> b.channel = b.version
       )`,
  ];
  return async (threadId: string): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sql of statements) await client.query(sql, [threadId]);
      await client.query("COMMIT");
    } catch (exc) {
      await client.query("ROLLBACK").catch(() => {});
      throw exc;
    } finally {
      client.release();
    }
  };
}

export interface RuntimeOptions {
  media?: MediaFactory;
  queue?: TaskQueue;
}

export async function buildRuntime(
  settings: Settings,
  opts: RuntimeOptions = {},
): Promise<WorkerRuntime> {
  const container = await buildContainer(settings, {
    withMedia: true,
    media: opts.media ?? defaultMediaFactory,
  });
  const database = container.database;
  if (!database) throw new Error("worker needs Postgres (USE_FAKES=false)");
  const saver = PostgresSaver.fromConnString(settings.databaseUrl, { schema: CHECKPOINT_SCHEMA });
  await saver.setup(); // creates/upgrades its tables (idempotent)
  const cipher = new CredentialCipher(settings.fernetKey.value);
  const pool = new ChannelPool(new ConnectionStore(database.db, cipher), settings);
  const queue = opts.queue ?? new BullTaskQueue(settings.redisUrl);
  const runtime: WorkerRuntime = {
    container,
    runner: new ConversationRunner(saver, checkpointPruner(database.pool)),
    pool,
    app: new AppChannel(container.appStore, new FfmpegAudio()),
    events: new EventLog(database.db),
    queue,
    async close() {
      await pool.close();
      await queue.close();
      await saver.end();
      await container.close();
    },
  };
  await container.media?.warmUp?.();
  log.info("worker_ready");
  return runtime;
}
