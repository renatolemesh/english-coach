import { describe, expect, it } from "vitest";
import {
  brDateTime,
  endOfDay,
  isoDay,
  localMidnight,
  previousDay,
  safeZone,
} from "../../src/panel/zones.js";

describe("zones", () => {
  it("the end of a date input is 23:59:59 local", () => {
    expect(endOfDay("2026-10-31", "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-01T02:59:59.000Z",
    );
    expect(endOfDay("2026-07-01", "Europe/Berlin")?.toISOString()).toBe("2026-07-01T21:59:59.000Z");
    expect(endOfDay("", "America/Sao_Paulo")).toBeNull();
    expect(endOfDay("2026-02-30", "America/Sao_Paulo")).toBeNull();
    expect(endOfDay("31/10/2026", "America/Sao_Paulo")).toBeNull();
  });

  it("local midnight and days follow the zone", () => {
    const now = new Date("2026-09-28T01:30:00Z"); // 22:30 of the 27th in São Paulo
    expect(localMidnight("America/Sao_Paulo", now).toISOString()).toBe("2026-09-27T03:00:00.000Z");
    expect(isoDay(now, "America/Sao_Paulo")).toBe("2026-09-27");
    expect(isoDay(now, "UTC")).toBe("2026-09-28");
    expect(brDateTime(now, "America/Sao_Paulo")).toBe("27/09/2026 22:30");
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
  });

  it("an unknown zone falls back to São Paulo", () => {
    expect(safeZone("Mars/Base")).toBe("America/Sao_Paulo");
    expect(safeZone("")).toBe("America/Sao_Paulo");
    expect(safeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});
