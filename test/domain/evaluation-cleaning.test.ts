import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cleanEvaluation,
  DEFAULT_TIP,
  DEFAULT_TIP_GOOD,
  Evaluation,
  feedbackForReply,
  type Mistake,
  normalize,
  overallScore,
  SAME_CASE,
  type ScoreBreakdown,
  UNCLEAR,
} from "../../src/domain/evaluation.js";

function ev(
  transcript: string,
  mistakes: [string, string][],
  extra: Partial<Record<keyof Evaluation, unknown>> = {},
): Evaluation {
  return Evaluation.parse({
    transcript,
    corrected: "", // "": no corrected-text check
    score: 0,
    score_breakdown: { grammar: 80, vocabulary: 80, fluency: 80, task: 80 },
    mistakes: mistakes.map(([original, correction]) => ({
      original,
      correction,
      type: "grammar",
      explanation: "x.",
    })),
    strengths: [],
    tip: "t",
    ...extra,
  });
}

const originals = (e: Evaluation): string[] => e.mistakes.map((m) => m.original);
const pairs = (e: Evaluation): [string, string][] =>
  e.mistakes.map((m) => [m.original, m.correction]);
const first = (e: Evaluation): Mistake => e.mistakes[0] as Mistake;
const withCorrected = (e: Evaluation, corrected: string): Evaluation => ({ ...e, corrected });

describe("evaluation cleaning", () => {
  it("normalize ignores speech recognition noise", () => {
    expect(normalize("um I went to the the beach in São Paulo!")).toBe(
      "um i went to the beach in sao paulo",
    );
  });

  it("changes that are only punctuation accents or repeats are dropped", () => {
    const e = ev("I went to the the beach in Sao Paulo, it was amazing", [
      ["the the beach", "the beach"],
      ["Sao Paulo, it", "São Paulo; it"],
      ["I went", "I go"],
    ]);
    const [cleaned, dropped] = cleanEvaluation(e, false);
    expect(originals(cleaned)).toEqual(["I went"]);
    expect(dropped).toHaveLength(2);
  });

  it("fragments not in the answer whole answers and overlaps are dropped", () => {
    const answer = "I am work in a bank since five years and I like very much my job";
    const e = ev(answer, [
      [answer, "I have worked in a bank for five years and I really like my job"],
      ["I am work", "I have worked"],
      ["am work in a bank", "have worked at a bank"], // overlaps the previous one
      ["since five years", "for five years"],
      ["I likes", "I like"], // not in the answer
    ]);
    const [cleaned, notes] = cleanEvaluation(e, false);
    // the precise ones win; the whole-answer item still contributes the change nobody else had
    expect(originals(cleaned)).toEqual(["I like very much my", "I am work", "since five years"]);
    const kinds = notes.map((n) => n.split(":")[0]).sort();
    expect(kinds).toEqual(["not_in_answer", "overlap", "overlap", "overlap", "split"]);
  });

  it("a whole sentence mistake is shrunk to what changes", () => {
    const answer = "I pretend to travel to Europe next year with my wife";
    const fixed = answer.replace("pretend", "intend");
    const [cleaned, notes] = cleanEvaluation(ev(answer, [[answer, fixed]]), false);
    expect(pairs(cleaned)).toEqual([["I pretend to", "I intend to"]]);
    expect(notes).toEqual([`shrunk:${answer.slice(0, 40)}`]);
  });

  it("distant changes in one mistake are split", () => {
    const answer = "Yesterday I go to the big market near my house and I buyed some apples";
    const fixed = "Yesterday I went to the big market near my house and I bought some apples";
    const [cleaned] = cleanEvaluation(ev(answer, [[answer, fixed]]), false);
    expect(pairs(cleaned)).toEqual([
      ["I go to", "I went to"],
      ["I buyed some", "I bought some"],
    ]);
  });

  it("a lone short word gets the word before it", () => {
    const answer = "In my city the people is friendly and there have many parks";
    const e = ev(answer, [
      ["is", "are"],
      ["have", "are"],
    ]);
    const [cleaned] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([
      ["people is", "people are"],
      ["there have", "there are"],
    ]);
    const [thisOne] = cleanEvaluation(ev("this is it", [["is", "are"]]), false);
    expect(originals(thisOne)).toEqual(["this is"]); // word match: never inside "this"
  });

  it("strengths in portuguese are dropped", () => {
    const e = ev("Hello", [], {
      strengths: [
        "'Hello' is a correct greeting.",
        "Ótima saudação.",
        "Boa resposta, bem natural.",
        "Clear and friendly.",
      ],
    });
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.strengths).toEqual(["'Hello' is a correct greeting.", "Clear and friendly."]);
  });

  it("a short answer can be a mistake as a whole", () => {
    const [cleaned] = cleanEvaluation(
      ev("I have 20 years", [["I have 20 years", "I'm 20"]]),
      false,
    );
    expect(originals(cleaned)).toEqual(["I have 20 years"]);
  });

  it("strengths never praise a mistake", () => {
    const e = ev("in the night we eat fish", [["in the night", "at night"]], {
      strengths: ["You used 'in the night' correctly.", "A clear sentence about it."],
    });
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.strengths).toEqual(["A clear sentence about it."]);
  });

  it("made up memory is removed unless there is memory", () => {
    const e = ev("I have gone to Rio last year", [["I have gone", "I went"]]);
    first(e).explanation = "Use the past form. You made this mistake before.";
    const [cleaned] = cleanEvaluation(e, false);
    expect(first(cleaned).explanation).toBe("Use the past form.");
    const [kept] = cleanEvaluation(e, true);
    expect(first(kept).explanation).toContain("mistake before");
  });

  it("overall score is computed and capped when the question is ignored", () => {
    const e = ev("Hello", [], {
      score_breakdown: { grammar: 100, vocabulary: 100, fluency: 100, task: 0 },
    });
    expect(overallScore(e.score_breakdown)).toBe(50); // task 0: at most 50
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.score).toBe(50);
    const hello: ScoreBreakdown = { ...e.score_breakdown, task: 30 };
    expect(overallScore(hello)).toBe(65); // task 30: at most 65, not 82
    const good = ev("x", [], {
      score_breakdown: { grammar: 90, vocabulary: 80, fluency: 70, task: 100 },
    });
    expect(overallScore(good.score_breakdown)).toBe(85);
  });

  it("implausible corrections are dropped", () => {
    const cases: [string, [string, string], string, string][] = [
      [
        "my favorite band is Foo Fighters",
        ["Foo Fighters", "the Foo Fighters"],
        "My favorite band is the Foo Fighters.",
        "article_before_name",
      ],
      [
        "Yes I went to their show in Sao Paulo",
        ["their show", "the Foo Fighters"],
        "Yes, I went to their show in São Paulo.",
        "not_in_corrected",
      ],
      [
        "I want a pizza and a coke please",
        ["I want", "I'd like"],
        "I'd like a pizza and a coke, please.",
        "register",
      ],
    ];
    for (const [answer, mistake, corrected, reason] of cases) {
      const e = withCorrected(ev(answer, [mistake]), corrected);
      const [cleaned, notes] = cleanEvaluation(e, false);
      expect(cleaned.mistakes, answer).toEqual([]);
      expect(notes, answer).toEqual([`${reason}:${mistake[0]}`]);
    }
  });

  it("a real article mistake is kept", () => {
    const e = withCorrected(
      ev("I have a dog and dog is big", [["and dog is", "and the dog is"]]),
      "I have a dog and the dog is big.",
    );
    const [cleaned] = cleanEvaluation(e, false);
    expect(originals(cleaned)).toEqual(["and dog is"]);
  });

  it("no mistakes means corrected is the answer and language scores are high", () => {
    let e = ev("i don't know", [], {
      score_breakdown: { grammar: 60, vocabulary: 0, fluency: 70, task: 10 },
    });
    e = withCorrected(e, "Hello! I'm [Name] from Brazil.");
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.mistakes).toEqual([]);
    expect(cleaned.corrected).toBe("I don't know.");
    expect([cleaned.score_breakdown.grammar, cleaned.score_breakdown.vocabulary]).toEqual([90, 80]);
    expect(cleaned.score).toBe(55); // task 10: at most 50 + 5
  });

  it("portuguese sentences are removed from english feedback", () => {
    const e = ev("I like to swim", [], {
      tip: "Great job. Continue assim, está ótimo. Use o simple past.",
    });
    let [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.tip).toBe("Great job.");
    const quoted = ev("I pretend to go", [["I pretend", "I intend"]]);
    first(quoted).explanation = "'Pretend' means 'fingir'. For 'pretender', say 'intend'.";
    [cleaned] = cleanEvaluation(quoted, false);
    expect(first(cleaned).explanation).toBe(first(quoted).explanation);
  });

  it("mistakes are aligned with the corrected text", () => {
    const answer = "When I was child I go to the beach every summer";
    const e = withCorrected(
      ev(answer, [
        ["I go", "went"],
        ["When I was child", "a child"],
      ]),
      "When I was a child, I went to the beach every summer.",
    );
    const [cleaned, notes] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([
      ["I go", "I went"],
      ["When I was child", "When I was a child"],
    ]);
    expect(notes).toEqual(["aligned:I go", "aligned:When I was child"]);
  });

  it("alignment ignores glue words", () => {
    const e = withCorrected(
      ev("I like to play guitar, I play since I was fifteen", [
        ["I play since I was fifteen", "and I have been playing"],
      ]),
      "I like to play guitar, and I've been playing since I was fifteen.",
    );
    const [cleaned] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([
      ["I play since I was fifteen", "I've been playing since I was fifteen"],
    ]);
  });

  it("pieces of one mistake do not repeat the explanation", () => {
    const answer = "Yesterday I go to the big market near my house and I buyed some apples";
    const fixed = "Yesterday I went to the big market near my house and I bought some apples";
    const e = ev(answer, [[answer, fixed]]);
    first(e).explanation = "Use the past form.";
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.mistakes.map((m) => m.explanation)).toEqual(["Use the past form.", SAME_CASE]);
  });

  it("corrected without mistakes drops fillers and repeats", () => {
    const e = withCorrected(ev("um so I uh went to the the beach", []), "Um so I uh went...");
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.corrected).toBe("So I went to the beach.");
  });

  it("capitalization and garbled text are removed", () => {
    const e = ev("I cook on sunday", [["on sunday", "on Sundays"]], {
      strengths: ["Good sentence, shows moreEducation.", "Clear sentence."],
    });
    first(e).explanation =
      "Days of the week always start with a capital letter. Use the plural for habits.";
    const [cleaned] = cleanEvaluation(e, false);
    expect(first(cleaned).explanation).toBe("Use the plural for habits.");
    expect(cleaned.strengths).toEqual(["Clear sentence."]);
  });

  // Real outputs of the free model (eval round 5) that the repair pipeline got wrong before.
  const LONG_ANSWER =
    "When I was child I go to the beach every summer with my parents and my brother, we was " +
    "very happy, we make many things together like to swim and to play football in the sand, " +
    "and in the night we eat fish in a restaurant near of our house, I miss very much this time";
  const LONG_CORRECTED =
    "When I was a child, I went to the beach every summer with my relatives and my brother. " +
    "We were very happy and did many things together, like swimming and playing football in " +
    "the sand. At night, we ate fish in a restaurant near our house. I miss that time very much.";

  it("a repeated word is fixed where the correction applies", () => {
    const mistakes: [string, string][] = [
      ["was", "were"],
      ["we make many things", "did many things"],
    ];
    const e = withCorrected(ev(LONG_ANSWER, mistakes), LONG_CORRECTED);
    const [cleaned, notes] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([
      ["we was", "we were"], // not "I was" in "When I was child"
      ["we make many things", "we did many things"], // subject kept though clauses merged
    ]);
    expect(notes).toContain("moved:was");
  });

  it("a slightly miscopied long mistake is still found", () => {
    const answer =
      "Last year I have gone to Rio with my family and we stayed in a hotel near the sea";
    const miscopied = "I have gone to Rio with my family and we stayed at a hotel"; // 'at' for 'in'
    const mistake: [string, string] = [
      miscopied,
      "I went to Rio with my family and we stayed at a hotel",
    ];
    const corrected =
      "Last year I went to Rio with my family and we stayed in a hotel near the sea.";
    const e = withCorrected(ev(answer, [mistake]), corrected);
    const [cleaned] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([["I have gone to", "I went to"]]);
  });

  it("a split mistake keeps its first part next to the models own", () => {
    const answer = "I am work in a bank since five years and I like very much my job";
    const e = withCorrected(
      ev(answer, [
        ["am work in a bank since five years", "have been working in a bank for five years"],
        ["since five years", "for five years"],
      ]),
      "I have been working in a bank for five years, and I really like my job.",
    );
    const [cleaned] = cleanEvaluation(e, false);
    expect(originals(cleaned)).toEqual(["am work in", "since five years"]);
  });

  it("the tip does not teach a dropped mistake", () => {
    const e = withCorrected(
      ev("my favorite band is Foo Fighters", [["Foo Fighters", "the Foo Fighters"]], {
        tip: "Great answer. Remember to say 'the Foo Fighters' with the article.",
      }),
      "My favorite band is Foo Fighters.",
    );
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.tip).toBe("Great answer.");
  });

  it("play guitar needs no article and tips with ellipsis are filtered", () => {
    const e = withCorrected(
      ev("I like to play guitar", [["play guitar", "play the guitar"]]),
      "I like to play the guitar.",
    );
    let [cleaned, notes] = cleanEvaluation(e, false);
    expect(cleaned.mistakes).toEqual([]);
    expect(notes).toEqual(["play_instrument:play guitar"]);
    const band = withCorrected(
      ev("my favorite band is Foo Fighters", [["Foo Fighters", "the Foo Fighters"]], {
        tip: "Nice! Remember the article before bands, like... 'the Foo Fighters'.",
      }),
      "My favorite band is the Foo Fighters.",
    );
    [cleaned, notes] = cleanEvaluation(band, false);
    expect(cleaned.tip).toBe("Nice!");
  });

  // Cases from the code review: legitimate corrections the filters used to drop.
  it.each<[string, [string, string], string]>([
    // capital only because the sentence starts
    [
      "Weather is very nice today.",
      ["Weather is", "The weather is"],
      "The weather is very nice today.",
    ],
    ["I love the Brazil.", ["the Brazil", "Brazil"], "I love Brazil."], // article removed
    ["Me like pizza", ["Me like", "I like"], "I like pizza."], // not a register swap
    // hyphenated correction
    ["It is a good knowed place", ["good knowed", "well-known"], "It is a well-known place."],
  ])("real corrections are kept: %s", (answer, mistake, corrected) => {
    const [cleaned, notes] = cleanEvaluation(
      withCorrected(ev(answer, [mistake]), corrected),
      false,
    );
    expect(cleaned.mistakes, notes.join(", ")).toHaveLength(1);
  });

  it("english feedback and brands are not taken for portuguese", () => {
    let e = ev("I watch YouTube every day", [["watch YouTube every", "watch YouTube every"]], {
      strengths: [
        "You watch YouTube every day: good everyday vocabulary.",
        "Nice use of 'every day' for habits.",
        "Clear answer about São Paulo.",
      ],
    });
    let [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.strengths).toEqual(e.strengths);
    e = ev("I go to school", [["I go", "I went"]]);
    first(e).explanation = "Use a past form here. Say 'went', not 'go'.";
    [cleaned] = cleanEvaluation(e, false);
    expect(first(cleaned).explanation).toBe("Use a past form here. Say 'went', not 'go'.");
  });

  it("a fully filtered tip becomes the default not the models text", () => {
    const e = withCorrected(
      ev("my favorite band is Foo Fighters", [["Foo Fighters", "the Foo Fighters"]], {
        tip: "Remember: the Foo Fighters.",
      }),
      "My favorite band is the Foo Fighters.",
    );
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.tip).toBe(DEFAULT_TIP_GOOD); // task 80: the answer did answer the question
    const off: Evaluation = { ...e, score_breakdown: { ...e.score_breakdown, task: 20 } };
    expect(cleanEvaluation(off, false)[0].tip).toBe(DEFAULT_TIP);
  });

  it("cjk noise in feedback is dropped", () => {
    const e = ev("I like pizza", [], {
      strengths: ["Common vocabulary in英语.", "Clear sentence."],
      tip: "Good sentence. Use more adjectives for the英文.",
    });
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.strengths).toEqual(["Clear sentence."]);
    expect(cleaned.tip).toBe("Good sentence.");
  });

  it("a guessed correction becomes unclear and leaves the natural version", () => {
    // real case (26/09): Whisper garbled the end; the model filled it from the history
    const answer = "My main stack is web development and I work has been show use.";
    const guess = "I have been working as a software engineer for five years";
    const e = withCorrected(
      ev(answer, [["I work has been show use", guess]], {
        tip:
          "Use 'for' with time. For example: 'I have been working as a software engineer " +
          "for five years.' Keep practicing.",
      }),
      `My main stack is web development, and ${guess}.`,
    );
    const [cleaned, notes] = cleanEvaluation(e, false);
    expect(cleaned.mistakes).toHaveLength(1);
    const m = first(cleaned);
    expect([m.type, m.original, m.correction]).toEqual([
      "unclear",
      "I work has been show use",
      "I work has been show use",
    ]);
    expect(m.explanation).toBe(UNCLEAR);
    expect(cleaned.corrected).not.toContain("software engineer");
    expect(cleaned.tip).toBe("Use 'for' with time. Keep practicing.");
    expect(notes).toEqual(["invented:I work has been show use"]);
    expect(cleaned.score_breakdown.grammar).toBeGreaterThanOrEqual(80); // audio noise is not grammar
  });

  it("real corrections are not taken for guesses", () => {
    const answer = "I am work in a bank since five years and I like very much my job";
    const e = ev(answer, [
      ["I am work in a bank", "I have been working at a bank"],
      ["I like very much my job", "I really like my job"],
    ]);
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.mistakes.map((m) => m.type)).not.toContain("unclear");
  });

  it("the model can mark a fragment unclear but not a short clear one", () => {
    const garble = "flurb gat zon has show";
    const e = ev(`I go to the ${garble} yesterday`, [[garble, garble]]);
    first(e).type = "unclear";
    let [cleaned, notes] = cleanEvaluation(e, false);
    expect(cleaned.mistakes.map((m) => [m.type, m.original])).toEqual([["unclear", garble]]);
    const short = ev("Like about two years.", [["about two years", "about two years"]]);
    first(short).type = "unclear"; // real case: clear, only off the question
    [cleaned, notes] = cleanEvaluation(short, false);
    expect(cleaned.mistakes).toEqual([]);
    expect(notes).toEqual(["short_unclear:about two years"]);
  });

  it("scores are fair to short answers and bad audio", () => {
    const scores = { grammar: 40, vocabulary: 80, fluency: 80, task: 90 };
    const article = ev(
      "I'm software engineer",
      [["I'm software engineer", "I'm a software engineer"]],
      {
        score_breakdown: scores,
      },
    );
    expect(cleanEvaluation(article, false)[0].score_breakdown.grammar).toBe(85);
    const fine = ev("my favorite band is Foo Fighters", [], {
      score_breakdown: { ...scores, grammar: 80 },
    });
    expect(cleanEvaluation(fine, false)[0].score_breakdown.grammar).toBe(90);
  });

  it("an explanation saying it is correct drops the mistake", () => {
    const e = ev("Yes I went there, it was amazing", [["it was", "It was"]]);
    first(e).explanation = "The sentence is correct, but a new sentence reads better.";
    expect(cleanEvaluation(e, false)[0].mistakes).toEqual([]);
    const style = ev("and usually I work in two companies", [["and usually I", "and then I"]]);
    first(style).explanation = "'Usually I work' is correct, but 'then' is clearer.";
    expect(cleanEvaluation(style, false)[0].mistakes).toEqual([]);
  });

  it("the tidy answer has no double spaces", () => {
    const [cleaned] = cleanEvaluation(ev("I wake up at 7 a.m. and I work", []), false);
    expect(cleaned.corrected).toBe("I wake up at 7 a.m. and I work.");
  });

  // Eval round 27/09 (free model), each dropped by a rule that already existed or a new one.
  it("a mistake widened by the code is checked again", () => {
    const e = withCorrected(
      ev("I like to play guitar", [["guitar", "the guitar"]]),
      "I like to play the guitar.",
    );
    const [cleaned, notes] = cleanEvaluation(e, false);
    expect(cleaned.mistakes).toEqual([]);
    expect(notes).toContain("play_instrument:guitar");
  });

  it("dropping yes or explaining punctuation is not a mistake", () => {
    const answer = "Yes I went to their show in Sao Paulo in 2018, it was amazing";
    const yes = ev(answer, [["Yes I", "I"]]);
    expect(cleanEvaluation(yes, false)[0].mistakes).toEqual([]);
    const comma = ev(answer, [["2018, it", "2018. It"]]);
    first(comma).explanation = "Add a semicolon between the two clauses.";
    expect(cleanEvaluation(comma, false)[0].mistakes).toEqual([]);
    const since = ev("I work here since two years", [["since two years", "for two years"]]);
    first(since).explanation = "Use 'for' with a period of time."; // 'period' is fine
    expect(cleanEvaluation(since, false)[0].mistakes).toHaveLength(1);
  });

  it("only unclear parts keep the students own words as natural version", () => {
    const same = "Like about two years";
    const e = withCorrected(
      ev("Like about two years.", [[same, same]]),
      "Like about two years ago.",
    );
    first(e).type = "unclear";
    const [cleaned] = cleanEvaluation(e, false);
    expect(cleaned.corrected).toBe("Like about two years."); // no 'ago' added
  });

  it("a word heard the way it sounded is a pronunciation hint", () => {
    // real case (28/09): 'And after, send another audio to Konshinui, the Tzauki'
    const answer = "And after, send another audio to Konshinui, the Tzauki, and it's for learning";
    const e = withCorrected(
      ev(answer, [
        ["Konshinui", "continue"],
        ["Tzauki", "talk"],
      ]),
      "And after that, I send another audio to continue the talk.",
    );
    for (const m of e.mistakes) m.type = "pronunciation";
    const [cleaned] = cleanEvaluation(e, false);
    expect(pairs(cleaned)).toEqual([
      ["Konshinui", "continue"],
      ["Tzauki", "talk"],
    ]);
    expect(new Set(cleaned.mistakes.map((m) => m.type))).toEqual(new Set(["pronunciation"]));
    expect(feedbackForReply(cleaned)).toContain("Heard as 'Konshinui', probably 'continue'");
  });
});

// Golden outputs (test/fixtures/evaluation-parity.json): cleanEvaluation, normalize and
// overallScore on many inputs, including extra learner answers; the code must give the same output.
interface ParityCase {
  source: string;
  input: unknown;
  has_memory: boolean;
  output: Evaluation;
  notes: string[];
  feedback: string;
}
interface Parity {
  normalize: [string, string][];
  overall_score: [number, number, number, number, number][];
  cases: ParityCase[];
}
const PARITY: Parity = JSON.parse(
  readFileSync(new URL("../fixtures/evaluation-parity.json", import.meta.url), "utf8"),
);

describe("golden outputs of cleanEvaluation", () => {
  it("has the test inputs and the extra answers", () => {
    expect(PARITY.cases.filter((c) => c.source === "extra").length).toBeGreaterThanOrEqual(30);
    expect(PARITY.cases.length).toBeGreaterThanOrEqual(80);
  });

  it.each(PARITY.normalize)("normalize(%j)", (text, expected) => {
    expect(normalize(text)).toBe(expected);
  });

  it.each(PARITY.overall_score)("overallScore(%i, %i, %i, %i)", (g, v, f, t, expected) => {
    expect(overallScore({ grammar: g, vocabulary: v, fluency: f, task: t })).toBe(expected);
  });

  it.each(PARITY.cases.map((c, i) => [i, c.source, c] as const))("case %i (%s)", (_, __, c) => {
    const input = Evaluation.parse(c.input);
    const before = structuredClone(input);
    const [cleaned, notes] = cleanEvaluation(input, c.has_memory);
    expect({ evaluation: cleaned, notes }).toEqual({ evaluation: c.output, notes: c.notes });
    expect(feedbackForReply(cleaned)).toBe(c.feedback);
    expect(input).toEqual(before); // the input is never mutated
  });
});
