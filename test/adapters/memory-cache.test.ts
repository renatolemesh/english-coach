import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { LockTimeoutError } from "../../src/ports/cache.js";

describe("memory cache", () => {
  it("counts, expires and sets only once", async () => {
    const cache = new MemoryCache();
    expect(await cache.incr("n", 1, 60)).toBe(1);
    expect(await cache.incr("n", 2.5)).toBe(3.5);
    expect(await cache.setIfAbsent("k", Buffer.from("a"), 60)).toBe(true);
    expect(await cache.setIfAbsent("k", Buffer.from("b"), 60)).toBe(false);
    await cache.set("gone", Buffer.from("x"), 0.001);
    await new Promise((r) => setTimeout(r, 5));
    expect(await cache.get("gone")).toBeNull();
  });

  it("serializes work under a lock and times out waiting", async () => {
    const cache = new MemoryCache();
    const order: string[] = [];
    let unblock!: () => void;
    const first = cache.withLock("t", 10, 1, async () => {
      order.push("a");
      await new Promise<void>((r) => {
        unblock = r;
      });
    });
    await expect(cache.withLock("t", 10, 0.01, async () => "late")).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    unblock();
    await first;
    expect(await cache.withLock("t", 10, 1, async () => "ok")).toBe("ok");
    expect(order).toEqual(["a"]);
  });
});
