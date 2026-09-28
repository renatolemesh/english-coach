/** Redis-backed Cache: LLM/TTS/STT/embedding cache, idempotency, rate limits, thread locks.
 * Every key starts with "coach:"; keep that prefix, existing counters and codes live under it. */
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { getLogger } from "../../logging.js";
import { type Cache, LockTimeoutError } from "../../ports/cache.js";

const log = getLogger("coach.adapters.cache.redis");
const LOCK_POLL_MS = 100;
// Release only our own lock (it may have expired and been taken by another worker).
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export class RedisCache implements Cache {
  constructor(
    private readonly r: Redis,
    private readonly prefix = "coach:",
  ) {}

  static fromUrl(url: string): RedisCache {
    return new RedisCache(
      new Redis(url, { connectTimeout: 2000, commandTimeout: 5000, maxRetriesPerRequest: 2 }),
    );
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.r.getBuffer(this.k(key));
  }

  /** Best-effort: a full Redis (noeviction) must not break the pipeline for a cache write. */
  async set(key: string, value: Buffer, ttlS?: number | null): Promise<void> {
    try {
      if (ttlS) await this.r.set(this.k(key), value, "EX", Math.ceil(ttlS));
      else await this.r.set(this.k(key), value);
    } catch (exc) {
      log.warning("cache_set_failed", { key: key.split(":", 1)[0], error: String(exc) });
    }
  }

  async getOrSet(key: string, factory: () => Promise<Buffer>, ttlS?: number | null) {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await factory();
    await this.set(key, value, ttlS);
    return value;
  }

  async delete(key: string): Promise<void> {
    await this.r.del(this.k(key));
  }

  async setIfAbsent(key: string, value: Buffer, ttlS: number): Promise<boolean> {
    return (await this.r.set(this.k(key), value, "EX", Math.ceil(ttlS), "NX")) === "OK";
  }

  async incr(key: string, amount = 1, ttlS?: number | null): Promise<number> {
    const k = this.k(key);
    const pipe = this.r.multi().incrbyfloat(k, amount);
    if (ttlS) pipe.expire(k, Math.ceil(ttlS), "NX");
    const result = await pipe.exec();
    return Number(result?.[0]?.[1]);
  }

  async withLock<T>(name: string, timeoutS: number, waitS: number, fn: () => Promise<T>) {
    const key = this.k(`lock:${name}`);
    const token = randomBytes(16).toString("hex");
    const deadline = Date.now() + waitS * 1000;
    while ((await this.r.set(key, token, "PX", Math.ceil(timeoutS * 1000), "NX")) !== "OK") {
      if (Date.now() >= deadline) throw new LockTimeoutError(`lock ${name} busy for ${waitS}s`);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      if (Number(await this.r.eval(RELEASE, 1, key, token)) === 0) {
        log.warning("lock_expired", { name });
      }
    }
  }

  async ping(): Promise<boolean> {
    return (await this.r.ping()) === "PONG";
  }

  async close(): Promise<void> {
    this.r.disconnect();
  }
}
