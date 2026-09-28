// Needs the stack's Redis on 127.0.0.1:6380 (docker compose up -d cache); uses db 15.
import { afterAll, describe, expect, it } from "vitest";
import { RedisCache } from "../../src/adapters/cache/redis.js";
import { LockTimeoutError } from "../../src/ports/cache.js";

const cache = RedisCache.fromUrl("redis://127.0.0.1:6380/15");
afterAll(() => cache.close());

describe("redis cache", () => {
  it("stores bytes, counts with TTL and sets only once", async () => {
    await cache.delete("t:n");
    await cache.set("t:b", Buffer.from([0, 255, 7]), 30);
    expect([...((await cache.get("t:b")) ?? [])]).toEqual([0, 255, 7]);
    expect(await cache.incr("t:n", 1, 60)).toBe(1);
    expect(await cache.incr("t:n", 0.5, 60)).toBe(1.5);
    await cache.delete("t:once");
    expect(await cache.setIfAbsent("t:once", Buffer.from("1"), 30)).toBe(true);
    expect(await cache.setIfAbsent("t:once", Buffer.from("1"), 30)).toBe(false);
  });

  it("locks across callers", async () => {
    let release!: () => void;
    const held = cache.withLock(
      "t",
      10,
      1,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(cache.withLock("t", 10, 0.2, async () => 1)).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    release();
    await held;
    expect(await cache.withLock("t", 10, 1, async () => 2)).toBe(2);
  });
});
