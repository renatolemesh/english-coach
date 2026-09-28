import { describe, expect, it } from "vitest";
import { canonical, isFree } from "../../src/domain/commands.js";

describe("commands", () => {
  it("maps aliases in both languages", () => {
    expect(canonical("Tema")).toBe("topic");
    expect(canonical("NÍVEL")).toBe("level");
    expect(canonical("tradução")).toBe("translate");
    expect(canonical("professor")).toBe("voice");
    expect(canonical("língua")).toBe("language");
    expect(canonical("constructor")).toBe("unknown");
    expect(canonical("xyz")).toBe("unknown");
  });

  it("menus and fixed texts are free", () => {
    expect(isFree("menu", "")).toBe(true);
    expect(isFree("nivel", "B2")).toBe(true);
    expect(isFree("tema", "")).toBe(true);
    expect(isFree("tema", "travel")).toBe(false);
    expect(isFree("voz", "  ")).toBe(true);
    expect(isFree("voz", "george")).toBe(false); // runs TTS
    expect(isFree("velocidade", "80")).toBe(false);
    expect(isFree("reset", "")).toBe(false);
  });
});
