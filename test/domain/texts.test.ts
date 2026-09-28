import { describe, expect, it } from "vitest";
import { mainMenu } from "../../src/domain/choices.js";
import { EN, formatText, PT, parseLang, TEXTS, textsFor } from "../../src/domain/texts.js";
import { LEVELS, SUGGESTED_TOPICS } from "../../src/domain/topics.js";
import { SPEEDS } from "../../src/domain/tutors.js";

const keys = (o: object) => Object.keys(o).sort();

describe("texts", () => {
  it("both languages have the same blocked reasons", () => {
    expect(keys(EN.blocked)).toEqual(keys(PT.blocked));
    expect(keys(EN.menuRows)).toEqual(keys(PT.menuRows));
    expect(Object.keys(EN.menuRows)).toEqual(Object.keys(PT.menuRows)); // same row order too
    expect(EN.blocked.self_harm).toBe(PT.blocked.self_harm); // always Portuguese
  });

  it("EN and PT have exactly the same keys", () => {
    expect(keys(EN)).toEqual(keys(PT));
    for (const field of [
      "blocked",
      "menuRows",
      "topicNames",
      "levelNames",
      "accents",
      "genders",
      "speedNames",
    ] as const) {
      expect(keys(EN[field]), field).toEqual(keys(PT[field]));
    }
    expect(keys(EN.topicNames)).toEqual([...SUGGESTED_TOPICS].sort());
    expect(keys(EN.levelNames)).toEqual([...LEVELS].sort());
    expect(keys(EN.speedNames)).toEqual([...SPEEDS.keys()].sort());
    expect(mainMenu(EN).options.map((o) => o.id)).toEqual(mainMenu(PT).options.map((o) => o.id));
  });

  it.each([EN, PT])("every blocked message formats ($lang)", (t) => {
    const values = { topic: "travel", max_chars: 1000, max_seconds: 60, limit: 3 };
    for (const [reason, template] of Object.entries(t.blocked)) {
      const text = formatText(template, values);
      expect(text, reason).not.toMatch(/[{}]/);
    }
    expect(formatText(t.blocked.daily_limit ?? "", values)).toContain("3");
  });

  it("formatText behaves like str.format", () => {
    expect(formatText("*{topic}* {{x}}", { topic: "travel" })).toBe("*travel* {x}");
    expect(() => formatText("{topic}", {})).toThrow();
    expect(formatText(EN.welcome, { tutor: "Emma" })).toContain("with Emma.");
  });

  it("the formatted parts render as expected", () => {
    expect(EN.help).toContain("/level B1 - set your level (A1, A2, B1, B2, C1, C2)\n");
    expect(PT.topicList).toBe(
      "*Temas sugeridos*\n1. introducing yourself\n2. job interview\n" +
        "3. ordering at a restaurant\n4. travel\n5. shopping\n6. daily routine\n\n" +
        "Use /tema 2 ou /tema <qualquer tema>.",
    );
  });

  it("tutor description, article and speed label", () => {
    expect(EN.tutorDescription("british", "female")).toBe("British accent, female voice");
    expect(PT.tutorCalled("George", "male")).toBe("o George");
    expect(EN.tutorCalled("George", "male")).toBe("George");
    expect(EN.speedLabel(0.8)).toBe("0.8x");
    expect(PT.speedLabel(1.0)).toBe("1,0x");
  });

  it("language parsing and lookup", () => {
    expect(parseLang(" English ")).toBe("en");
    expect(parseLang("Português")).toBe("pt");
    expect(parseLang("2")).toBe("pt");
    expect(parseLang("es")).toBeNull();
    expect(textsFor("pt")).toBe(PT);
    expect(textsFor(null)).toBe(EN);
    expect(textsFor("xx")).toBe(EN);
    expect(TEXTS.en).toBe(EN);
  });
});
