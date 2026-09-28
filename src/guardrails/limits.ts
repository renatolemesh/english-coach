/** Per-student limits in the shared cache (Redis): messages per minute, messages per day (the
 * student's plan, reset at local midnight) and a daily token/cost budget. */
import type { Settings } from "../config.js";
import type { Cache } from "../ports/cache.js";
import { QUOTA_FLAG_KEY, type Usage } from "../ports/llm.js";

const DAY_S = 24 * 3600;
export const DEFAULT_TZ = "America/Sao_Paulo";

/** YYYYMMDD in the given zone (a typo in the panel falls back to São Paulo). */
export function localDay(tz: string = DEFAULT_TZ, now = new Date()): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(now)
      .replaceAll("-", "");
  try {
    return fmt(tz);
  } catch {
    return fmt(DEFAULT_TZ);
  }
}

const utcDay = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
const minute = () => Math.floor(Date.now() / 60_000);

export class UsageLimits {
  constructor(
    private readonly cache: Cache,
    private readonly settings: Settings,
  ) {}

  /** Count this message and return a block reason, or null. `perDay` is the plan's limit
   * (null: unlimited); a blocked message does not count against it. */
  async check(userId: string, perMinute?: number | null, perDay?: number | null, tz = DEFAULT_TZ) {
    if ((await this.cache.get(QUOTA_FLAG_KEY)) !== null) return "busy"; // LLM quota used up
    const count = await this.cache.incr(`rl:${userId}:${minute()}`, 1, 120);
    if (count > (perMinute || this.settings.rateLimitPerMinute)) return "rate_limited";
    const day = utcDay();
    const cost = await this.cache.get(`budget:cost:${userId}:${day}`);
    const tokens = await this.cache.get(`budget:tokens:${userId}:${day}`);
    if (cost !== null && Number(cost.toString()) >= this.settings.dailyCostBudgetUsd)
      return "budget";
    if (tokens !== null && Number(tokens.toString()) >= this.settings.dailyTokenBudget)
      return "budget";
    if (perDay !== null && perDay !== undefined) {
      if ((await this.usedToday(userId, tz)) >= perDay) return "daily_limit";
      await this.cache.incr(`msgs:${userId}:${localDay(tz)}`, 1, 2 * DAY_S);
    }
    return null;
  }

  /** True the first time it is asked on a local day: the daily-limit answer goes out once, not
   * for every message after the limit. */
  async firstLimitNotice(userId: string, tz = DEFAULT_TZ): Promise<boolean> {
    const key = `msgs:notice:${userId}:${localDay(tz)}`;
    return this.cache.setIfAbsent(key, Buffer.from("1"), 2 * DAY_S);
  }

  async usedToday(userId: string, tz = DEFAULT_TZ): Promise<number> {
    const raw = await this.cache.get(`msgs:${userId}:${localDay(tz)}`);
    return raw === null ? 0 : Math.trunc(Number(raw.toString()));
  }

  /** Menus and other commands without LLM: their own, looser per-minute limit, so browsing is
   * never blocked but a flood still is. */
  async checkFree(userId: string): Promise<string | null> {
    const count = await this.cache.incr(`rl:free:${userId}:${minute()}`, 1, 120);
    return count > this.settings.freeCommandsPerMinute ? "rate_limited" : null;
  }

  async record(userId: string, usage: Usage): Promise<void> {
    const day = utcDay();
    await this.cache.incr(`budget:cost:${userId}:${day}`, usage.costUsd, 2 * DAY_S);
    await this.cache.incr(
      `budget:tokens:${userId}:${day}`,
      usage.inputTokens + usage.outputTokens,
      2 * DAY_S,
    );
  }
}
