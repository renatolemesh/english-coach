/** LangGraph.js checkpoints in Postgres (schema lg_ts_test in coach_test): state survives
 * between turns, bytes in a failed step round-trip, and the pruner keeps one checkpoint. */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRunner, threadId } from "../../src/graph/runner.js";
import type { ConversationState } from "../../src/graph/state.js";
import { checkpointPruner } from "../../src/worker/runtime.js";
import { audioMsg, Harness, textMsg } from "../graph/harness.js";
import { TEST_DATABASE_URL } from "./helpers.js";

const SCHEMA = "lg_ts_test";
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
const saver = new PostgresSaver(pool, undefined, { schema: SCHEMA });
const TID = threadId(1);

const count = async (table: string) =>
  Number(
    (await pool.query(`SELECT count(*) FROM ${SCHEMA}.${table} WHERE thread_id = $1`, [TID]))
      .rows[0].count,
  );
const saved = async (h: Harness): Promise<ConversationState> =>
  (await h.runner.graph.getState({ configurable: { thread_id: TID } })).values;

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await saver.setup();
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

describe("postgres checkpoints", () => {
  it("keep the conversation between turns and only the latest checkpoint", async () => {
    const h = await Harness.create(
      undefined,
      new ConversationRunner(saver, checkpointPruner(pool, SCHEMA)),
    );
    await h.send(textMsg("oi"));
    h.channel.media.set("r1", [Buffer.from("I goed to the beach"), "audio/ogg"]);
    await h.send(audioMsg("r1"));
    expect(h.kinds()).toEqual(["image", "voice", "choice"]);
    const values = await saved(h);
    expect(values.turn_count).toBe(1);
    expect(values.recent_turns?.length).toBe(2);
    for (const heavy of ["image", "voice", "audio_in", "evaluation", "message"] as const) {
      expect(values[heavy] ?? null, heavy).toBeNull();
    }
    expect(await count("checkpoints")).toBe(1);
    expect(await count("checkpoint_writes")).toBe(0);
    // every kept blob is referenced by the kept checkpoint
    const orphans = await pool.query(
      `SELECT b.channel FROM ${SCHEMA}.checkpoint_blobs b JOIN ${SCHEMA}.checkpoints c USING (thread_id, checkpoint_ns)
       WHERE b.thread_id = $1 AND (c.checkpoint -> 'channel_versions' ->> b.channel) IS DISTINCT FROM b.version`,
      [TID],
    );
    expect(orphans.rows).toEqual([]);
  });

  it("a failed turn with bytes pending still clears the turn objects", async () => {
    const h = await Harness.create(
      undefined,
      new ConversationRunner(saver, checkpointPruner(pool, SCHEMA)),
    );
    h.llm.responses.conversation_reply = () => {
      throw new Error("unexpected bug in a node");
    };
    h.channel.media.set("r2", [Buffer.from("I like trains"), "audio/ogg"]);
    await expect(h.send(audioMsg("r2"))).rejects.toThrow("unexpected bug in a node");
    const values = await saved(h);
    for (const key of ["message", "audio_in", "evaluation", "image", "voice"] as const) {
      expect(values[key] ?? null, key).toBeNull();
    }
  });
});
