// Expected strings are reference outputs of the report and the checks on the same data.
import { describe, expect, it } from "vitest";
import {
  llmEvent,
  pyJson,
  pyRepr,
  pyStrRepr,
  RateWindow,
  report,
  routeOf,
  runChecks,
  type ScenarioResult,
  type StepResult,
  untilNextMinute,
} from "../../scripts/eval-report.js";

const base: StepResult = {
  input: {},
  setup: false,
  expect: "",
  route: "evaluated",
  texts: [],
  choices: [],
  caption: null,
  sent_kinds: [],
  evaluation: null,
  reply: null,
  errors: [],
  notes: [],
  llm_calls: [],
  llm_events: [],
  seconds: 0,
  failures: [],
};

describe("repr-style formatting", () => {
  it("reprs strings", () => {
    expect(pyStrRepr("hello")).toBe("'hello'");
    expect(pyStrRepr("it's")).toBe(`"it's"`);
    expect(pyStrRepr(`it's "x"`)).toBe(`'it\\'s "x"'`);
    expect(pyStrRepr("a\nb\\")).toBe("'a\\nb\\\\'");
    expect(pyStrRepr("olá")).toBe("'olá'");
    expect(pyStrRepr("a\u200bb\x7f\u00a0🎙️ \u{e0001}")).toBe("'a\\u200bb\\x7f\\xa0🎙️ \\U000e0001'");
  });

  it("reprs dicts, lists and none", () => {
    expect(pyRepr({ grammar: 90, task: 20 })).toBe("{'grammar': 90, 'task': 20}");
    expect(pyRepr(["a", true, null])).toBe("['a', True, None]");
  });

  it('dumps json with ", " and ": " separators', () => {
    expect(pyJson({ text: "olá", n: [1, 2] })).toBe('{"text": "olá", "n": [1, 2]}');
  });
});

describe("routes and checks", () => {
  it("routes like route_of", () => {
    expect(routeOf({ kind: "blocked", blocked_reason: "portuguese" })).toBe("portuguese");
    expect(routeOf({ kind: "blocked", blocked_reason: "abuse" })).toBe("blocked:abuse");
    expect(routeOf({ kind: "command" })).toBe("command");
    expect(routeOf({ kind: "text", evaluation: { score: 1 } })).toBe("evaluated");
    expect(routeOf({ kind: "text", evaluation: null })).toBe("no_evaluation");
  });

  it("reports every failed check", () => {
    const out = {
      ...base,
      texts: ["Hello there"],
      reply: "Hi! How are you? And you?",
      errors: ["x"],
      evaluation: {
        score: 70,
        score_breakdown: { grammar: 80, vocabulary: 60, fluency: 70, task: 40 },
        mistakes: [{ a: 1 }],
      },
    };
    const check = {
      route: "portuguese",
      score_min: 75,
      score_max: 60,
      grammar_min: 90,
      task_max: 30,
      mistakes_max: 0,
      mistakes_min: 2,
      contains: ["hello", "dog"],
      not_contains: ["there"],
      reply: false,
      no_errors: true,
    };
    expect(runChecks(check, out)).toEqual([
      "route 'evaluated' != 'portuguese'",
      "score 70 < 75",
      "score 70 > 60",
      "grammar 80 not min 90",
      "task 40 not max 30",
      "1 mistakes > 0",
      "1 mistakes < 2",
      "missing 'dog'",
      "has 'there'",
      "reply present=True, expected False",
      "errors ['x']",
    ]);
  });

  it("score checks without an evaluation fail", () => {
    expect(runChecks({ score_min: 1, grammar_min: 3, route: "evaluated" }, base)).toEqual([
      "score_min: no evaluation",
      "grammar_min: no evaluation",
    ]);
  });

  it("checks emma's reply on every step", () => {
    const failures = runChecks({}, { ...base, reply: `${"a".repeat(360)}.` });
    expect(failures).toEqual(["reply has 361 chars", "reply does not end with a question"]);
  });
});

describe("llm events", () => {
  it("formats watched log records", () => {
    expect(llmEvent({ event: "llm_retry", prompt_id: "evaluate_answer", attempt: 2 })).toBe(
      "evaluate_answer:llm_retry:2",
    );
    expect(llmEvent({ event: "evaluation_cleaned", prompt_id: "e", notes: ["a"] })).toBe(
      "e:evaluation_cleaned:['a']",
    );
    expect(llmEvent({ event: "reply_trimmed", before: "x y", after: "x" })).toBe(
      "None:reply_trimmed:'x y' -> 'x'",
    );
    expect(llmEvent({ event: "node_done" })).toBeNull();
  });
});

describe("report", () => {
  it("matches the reference report", () => {
    const results: ScenarioResult[] = [
      {
        id: "s1",
        topic: "travel",
        level: "B1",
        about: `It's about "quotes".`,
        steps: [
          {
            ...base,
            input: { text: "/tema travel" },
            setup: true,
            route: "command",
            choices: ["Pick one [tema:1 tema:2]"],
            llm_calls: [{ prompt: "opener", fallback: null, seconds: 1.2 }],
            seconds: 2,
          },
          {
            ...base,
            input: { audio: "I don't know, olá" },
            expect: "No mistakes.",
            texts: ["Line1\nline2", "it's"],
            caption: "Score 40",
            evaluation: {
              transcript: "I don't know",
              corrected: "I don't know",
              score: 40,
              score_breakdown: { grammar: 90, vocabulary: 60, fluency: 50, task: 20 },
              mistakes: [
                {
                  original: "near of",
                  correction: "near",
                  type: "grammar",
                  explanation: "Say 'near'.",
                },
              ],
              strengths: ["Clear."],
              tip: "Say more.",
            },
            reply: "Nice! What do you do?",
            errors: ["tts_failed"],
            notes: ["stt:-0.2", "mistake_dropped"],
            llm_calls: [
              { prompt: "evaluate_answer", fallback: null, seconds: 3.4 },
              { prompt: "reply", fallback: "invalid_output", seconds: 0.5 },
            ],
            llm_events: ["evaluate_answer:llm_retry:2"],
            seconds: 4.25,
            failures: ["task 20 not max 10", "missing 'dog'"],
          },
        ],
      },
    ];
    expect(report(results).split("\n")).toEqual([
      "# Conversation eval",
      "",
      "1 steps, 1 with failed checks.",
      "",
      "## s1 (travel, B1)",
      `It's about "quotes".`,
      "",
      '### > {"text": "/tema travel"}  [command] setup',
      "- choice: 'Pick one [tema:1 tema:2]'",
      "- llm: [opener] 2.0s",
      "",
      `### > {"audio": "I don't know, olá"}  [evaluated] FAIL task 20 not max 10; missing 'dog'`,
      "expect: No mistakes.",
      "- text: 'Line1\\nline2'",
      `- text: "it's"`,
      "- caption: 'Score 40'",
      "- score 40 {'grammar': 90, 'vocabulary': 60, 'fluency': 50, 'task': 20}",
      `  corrected: "I don't know"`,
      "  * 'near of' -> 'near' [grammar] Say 'near'.",
      "  strengths: ['Clear.']",
      "  tip: Say more.",
      "- Emma (voice): 'Nice! What do you do?'",
      "- errors: ['tts_failed']",
      "- fixed by code: ['mistake_dropped']",
      "- llm: [evaluate_answer, reply!invalid_output] 4.25s",
      "- llm events: ['evaluate_answer:llm_retry:2']",
      "",
    ]);
  });
});

describe("pacing", () => {
  it("waits for the oldest call to leave the 60 s window", async () => {
    let now = 0;
    const waits: number[] = [];
    const window = new RateWindow(
      2,
      () => now,
      async (s) => {
        waits.push(s);
        now += s;
      },
    );
    await window.acquire();
    now = 10;
    await window.acquire();
    now = 20;
    await window.acquire(); // third call: waits until the first is 60 s old
    expect(waits).toEqual([40]);
    expect(now).toBe(60);
    await window.acquire(); // the second (t=10) leaves at 70
    expect(waits).toEqual([40, 10]);
  });

  it("quota waits until just after the next minute", () => {
    expect(untilNextMinute(new Date("2026-01-01T10:00:50Z"))).toBe(12);
    expect(untilNextMinute(new Date("2026-01-01T10:00:00Z"))).toBe(62);
  });
});
