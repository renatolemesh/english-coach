/** Wall-clock time in an IANA zone without a date library (Intl only). */
import { DEFAULT_TZ } from "../guardrails/limits.js";

/** The zone if Intl knows it, else São Paulo (a typo in the panel settings must not break it). */
export function safeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function wallClock(date: Date, tz: string): WallClock {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** That wall-clock time in `tz`, as an instant (the offset re-checked once for DST edges). */
export function zonedToUtc(w: WallClock, tz: string): Date {
  const target = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offset = (at: number) => {
    const seen = wallClock(new Date(at), tz);
    return Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - at;
  };
  let at = target - offset(target);
  at = target - offset(at);
  return new Date(at);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 'YYYY-MM-DD' of the instant in `tz`. */
export function isoDay(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** 'DD/MM/YYYY' and 'DD/MM/YYYY HH:MM' in `tz`. */
export function brDay(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.day)}/${pad(w.month)}/${pad(w.year, 4)}`;
}

export function brDateTime(date: Date, tz: string): string {
  const w = wallClock(date, tz);
  return `${brDay(date, tz)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** The day before 'YYYY-MM-DD'. */
export function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Local midnight of today in `tz`, as an instant. */
export function localMidnight(tz: string, now = new Date()): Date {
  const w = wallClock(now, tz);
  return zonedToUtc({ ...w, hour: 0, minute: 0, second: 0 }, tz);
}

/** '2026-10-31' (date input) -> that day 23:59:59 local, as an instant; '' or invalid -> null. */
export function endOfDay(value: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return zonedToUtc({ year, month, day, hour: 23, minute: 59, second: 59 }, tz);
}

/** Monday 00:00 of this week in `tz`, as an instant (the weekly ranking starts there). */
export function weekStart(tz: string, now = new Date()): Date {
  const d = new Date(`${isoDay(now, tz)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const [year, month, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, tz);
}
