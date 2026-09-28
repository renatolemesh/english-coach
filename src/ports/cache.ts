/** Shared key-value cache (Redis in production, memory in tests). Values are bytes. */
export class LockTimeoutError extends Error {}

export interface Cache {
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, ttlS?: number | null): Promise<void>;
  getOrSet(key: string, factory: () => Promise<Buffer>, ttlS?: number | null): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Atomic SETNX with TTL; true if the key was created (idempotency). */
  setIfAbsent(key: string, value: Buffer, ttlS: number): Promise<boolean>;
  /** Increment a counter, setting the TTL on creation (rate limits, budgets). */
  incr(key: string, amount?: number, ttlS?: number | null): Promise<number>;
  /** Mutual exclusion across workers (auto-released after timeoutS). Throws LockTimeoutError
   * if it cannot be acquired within waitS. */
  withLock<T>(name: string, timeoutS: number, waitS: number, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
