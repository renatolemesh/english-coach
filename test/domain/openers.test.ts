import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/config.js";
import { loadOpeners, pickOpener } from "../../src/domain/openers.js";

const { dataDir } = loadSettings({});

describe("openers", () => {
  it("openers avoid recently used questions", () => {
    const lines = [...(loadOpeners(dataDir).get("travel") ?? [])];
    expect(lines.length).toBeGreaterThan(3);
    for (let i = 0; i < 20; i++) {
      expect(pickOpener(dataDir, "travel", { avoid: lines.slice(0, 3) })).toBe(lines[3]);
    }
    expect(lines).toContain(pickOpener(dataDir, "travel", { avoid: lines })); // all used: any
  });

  it("uses the injected random function and knows no custom topics", () => {
    const lines = loadOpeners(dataDir).get("travel") ?? [];
    expect(pickOpener(dataDir, "travel", { random: () => 0 })).toBe(lines[0]);
    expect(pickOpener(dataDir, "travel", { random: () => 0.9999 })).toBe(lines.at(-1));
    expect(pickOpener(dataDir, "football")).toBeNull();
    expect(loadOpeners(dataDir)).toBe(loadOpeners(`${dataDir}/`)); // cached per dir
    expect(loadOpeners(dataDir).size).toBe(6);
  });
});
