/** In-process Cache for tests and simulate (not shared between processes). */
import { type Cache, LockTimeoutError } from "../../ports/cache.js";

export class MemoryCache implements Cache {
  private readonly data = new Map<string, { value: Buffer; expires: number | null }>();
  private readonly locks = new Map<string, Promise<void>>();

  private alive(key: string): Buffer | null {
    const item = this.data.get(key);
    if (!item) return null;
    if (item.expires !== null && item.expires < performance.now()) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.alive(key);
  }

  async set(key: string, value: Buffer, ttlS?: number | null): Promise<void> {
    this.data.set(key, { value, expires: ttlS ? performance.now() + ttlS * 1000 : null });
  }

  async getOrSet(key: string, factory: () => Promise<Buffer>, ttlS?: number | null) {
    const cached = this.alive(key);
    if (cached !== null) return cached;
    const value = await factory();
    await this.set(key, value, ttlS);
    return value;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async setIfAbsent(key: string, value: Buffer, ttlS: number): Promise<boolean> {
    if (this.alive(key) !== null) return false;
    await this.set(key, value, ttlS);
    return true;
  }

  async incr(key: string, amount = 1, ttlS?: number | null): Promise<number> {
    const current = this.alive(key);
    if (current === null) {
      await this.set(key, Buffer.from(String(amount)), ttlS);
      return amount;
    }
    const total = Number(current.toString()) + amount;
    const item = this.data.get(key);
    this.data.set(key, { value: Buffer.from(String(total)), expires: item?.expires ?? null });
    return total;
  }

  async withLock<T>(name: string, _timeoutS: number, waitS: number, fn: () => Promise<T>) {
    const deadline = performance.now() + waitS * 1000;
    while (this.locks.has(name)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new LockTimeoutError(`lock ${name} busy for ${waitS}s`);
      await Promise.race([this.locks.get(name), new Promise((r) => setTimeout(r, remaining))]);
    }
    let release!: () => void;
    this.locks.set(
      name,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    try {
      return await fn();
    } finally {
      this.locks.delete(name);
      release();
    }
  }

  async close(): Promise<void> {}
}
