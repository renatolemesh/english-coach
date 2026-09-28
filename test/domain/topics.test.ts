import { describe, expect, it } from "vitest";
import { cleanTopic, MAX_TOPIC_CHARS, parseLevel } from "../../src/domain/topics.js";

describe("topics", () => {
  it("parses levels", () => {
    expect(parseLevel(" b2 ")).toBe("B2");
    expect(parseLevel("C3")).toBeNull();
    expect(parseLevel("")).toBeNull();
  });

  it("cleans free-text topics", () => {
    expect(cleanTopic("4")).toBe("travel"); // /tema 4: position in the list
    expect(cleanTopic("7")).toBe("7");
    expect(cleanTopic("  Football   and *Music*! ")).toBe("football and music");
    expect(cleanTopic("Futebol, São Paulo")).toBe("futebol, são paulo");
    expect(cleanTopic("see https://evil.com/x now")).toBe("see now");
    expect(cleanTopic("visit www.site.org")).toBe("visit");
    expect(cleanTopic("go to evil.com please")).toBe("go to please");
    expect(cleanTopic("my_topic")).toBe("my topic");
    expect(cleanTopic("--rock & roll--")).toBe("rock & roll");
    expect(cleanTopic("<>[]()")).toBeNull();
    expect(cleanTopic("a".repeat(100))).toHaveLength(MAX_TOPIC_CHARS);
  });
});
