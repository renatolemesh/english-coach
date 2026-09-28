/** The worker task. */
import { describe, expect, it } from "vitest";
import { FakeChannel } from "../../src/adapters/channels/fake.js";
import { MemoryEventLog } from "../../src/connections/events.js";
import type { PoolEntry } from "../../src/connections/pool.js";
import { buildContainer } from "../../src/container.js";
import { ConversationRunner } from "../../src/graph/runner.js";
import { MemoryTaskQueue } from "../../src/worker/queue.js";
import {
  handleJob,
  MAX_LOCK_ATTEMPTS,
  processMessage,
  REQUEUE_DELAY_S,
  type WorkerRuntime,
} from "../../src/worker/tasks.js";
import { testSettings } from "../api/helpers.js";
import { evoConn } from "../channels/helpers.js";

const MESSAGE = {
  id: "m1",
  from: "5541999990000",
  timestamp: "2026-09-25T12:00:00Z",
  type: "text",
  text: "oi",
};

async function workerRuntime(
  events = new MemoryEventLog(),
  channel = new FakeChannel(),
  over: Parameters<typeof testSettings>[0] = {},
): Promise<WorkerRuntime> {
  const container = await buildContainer(testSettings({ rateLimitPerMinute: 1000, ...over }), {
    withMedia: true,
  });
  return {
    container,
    runner: new ConversationRunner(),
    pool: {
      get: async (id: string): Promise<PoolEntry> =>
        id === "evo-main" ? [evoConn(), channel] : null,
    },
    events,
    queue: new MemoryTaskQueue(),
    close: async () => {},
  };
}

describe("worker", () => {
  it("ping task runs in memory queue", async () => {
    const rt = await workerRuntime();
    const queue = rt.queue as MemoryTaskQueue;
    await queue.add("ping", {});
    expect(await queue.drain((name, data) => handleJob(rt, name, data))).toEqual(["pong"]);
  });

  it("worker task runs the graph and marks event", async () => {
    const events = new MemoryEventLog();
    const channel = new FakeChannel();
    const rt = await workerRuntime(events, channel);
    expect(await processMessage(rt, "evo-main", MESSAGE, 7)).toBe("processed");
    expect(channel.sent.map((s) => s.kind)).toEqual(["text", "text", "voice", "choice"]); // welcome
    expect(events.marks).toEqual([[7, "processed", null]]);
    expect(await processMessage(rt, "gone", MESSAGE, 8)).toBe("connection_unavailable");
    expect(events.marks.at(-1)).toEqual([8, "failed", "connection unavailable"]);
  });

  it("redelivered task is skipped", async () => {
    const events = new MemoryEventLog();
    const channel = new FakeChannel();
    const rt = await workerRuntime(events, channel);
    expect(await processMessage(rt, "evo-main", MESSAGE, 1)).toBe("processed");
    const sent = channel.sent.length;
    expect(await processMessage(rt, "evo-main", MESSAGE, 1)).toBe("duplicate");
    expect(channel.sent.length).toBe(sent); // nothing sent twice
  });

  it("busy thread is requeued not dropped", async () => {
    const events = new MemoryEventLog();
    // THREAD_LOCK_WAIT_S is an int setting: 0 = give up at once
    const rt = await workerRuntime(events, new FakeChannel(), { threadLockWaitS: 0 });
    const queue = rt.queue as MemoryTaskQueue;
    let release!: () => void;
    const held = rt.container.cache.withLock(
      "thread:evo-main:5541999990000",
      5,
      1,
      () => new Promise<void>((r) => (release = r)),
    );
    const result = await processMessage(rt, "evo-main", MESSAGE, 3);
    release();
    await held;
    expect(result).toBe("requeued");
    expect(queue.jobs).toEqual([
      {
        name: "process_message",
        data: { connection_id: "evo-main", message: MESSAGE, event_id: 3, attempt: 1 },
        delayMs: REQUEUE_DELAY_S * 1000,
      },
    ]);
    expect(events.marks.at(-1)).toEqual([3, "queued", null]);
    expect(events.claimed.has(3)).toBe(false);
  });

  it("a thread busy for too long fails the event", async () => {
    const events = new MemoryEventLog();
    const rt = await workerRuntime(events, new FakeChannel(), { threadLockWaitS: 0 });
    let release!: () => void;
    const held = rt.container.cache.withLock(
      "thread:evo-main:5541999990000",
      5,
      1,
      () => new Promise<void>((r) => (release = r)),
    );
    const result = await processMessage(rt, "evo-main", MESSAGE, 4, MAX_LOCK_ATTEMPTS - 1);
    release();
    await held;
    expect(result).toBe("failed");
    expect(events.marks.at(-1)).toEqual([4, "failed", "thread busy"]);
    expect((rt.queue as MemoryTaskQueue).jobs).toEqual([]);
  });

  it("an invalid message fails without retry", async () => {
    const events = new MemoryEventLog();
    const rt = await workerRuntime(events);
    expect(await processMessage(rt, "evo-main", { id: "x" }, 5)).toBe("failed");
    expect(events.marks.at(-1)?.slice(0, 2)).toEqual([5, "failed"]);
    expect((rt.queue as MemoryTaskQueue).jobs).toEqual([]);
  });
});
