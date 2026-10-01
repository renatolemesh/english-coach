// The pure parts of the course build: the fidelity score and the hand overrides.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  closest,
  FIT_GOOD,
  FIT_MIN,
  type FitEn,
  type FitPt,
  fidelity,
  parseOverrides,
} from "../../scripts/build-course.js";
import { PROJECT_ROOT } from "../../src/config.js";
import { GOOD_FIT } from "../../src/course/planner.js";

// a tiny lexicon: English word -> [weight, Portuguese lemmas that translate it]
const LEX: Record<string, [number, string]> = {
  sometimes: [0.5, "vez"],
  i: [0, "eu"],
  can: [0.5, "poder conseguir"],
  not: [0, "não"],
  help: [1, "ajudar evitar"],
  show: [1, "mostrar demonstrar"],
  emotion: [1, "emoção sentimento"],
  my: [0, "meu"],
  dog: [1, "cachorro cão"],
  like: [1, "gostar"],
  water: [1, "água"],
  you: [0, "você"],
  destroy: [1, "destruir"],
  everything: [0, "tudo"],
  trouble: [1, "problema"],
};
// Portuguese token -> [weight, lemmas]; grammar words weigh 0, possessives and adverbs 0.5
const PT: Record<string, [number, string]> = {
  às: [0, "a"],
  vezes: [1, "vez"],
  não: [0, "não"],
  consigo: [1, "conseguir"],
  me: [0, "me"],
  segurar: [1, "segurar"],
  ao: [0, "a"],
  mostrar: [1, "mostrar"],
  minhas: [0.5, "meu"],
  emoções: [1, "emoção"],
  meu: [0.5, "meu"],
  gosta: [1, "gostar"],
  de: [0, "de"],
  você: [0, "você"],
  tudo: [0, "tudo"],
  estou: [0, "estar"],
  em: [0, "em"],
};

const en = (words: string): FitEn<string>[] =>
  words.split(" ").map((w) => {
    const [weight, trans] = LEX[w] ?? [0, ""];
    return { form: w, weight, trans: new Set(trans.split(" ").filter(Boolean)) };
  });
// unknown words are content words that are their own lemma ("cachorro", "destrói")
const pt = (text: string): FitPt<string>[] =>
  text.split(" ").map((w) => {
    const [weight, lemmas] = PT[w] ?? [1, w];
    return { form: w, weight, lemmas: [w, ...lemmas.split(" ")] };
  });

describe("fidelity", () => {
  // the production case: an order exercise showed the loose translation
  const emotions = en("sometimes i can not help show emotion");
  const loose = pt("às vezes não consigo me segurar ao mostrar minhas emoções");
  const closer = pt("às vezes não consigo evitar mostrar emoções");

  it("a word-for-word translation scores 1", () => {
    expect(fidelity(en("my dog like water"), pt("meu cachorro gosta de água")).fit).toBe(1);
    expect(fidelity(emotions, closer).fit).toBe(1);
  });

  it("a paraphrase loses what it adds and what it leaves out", () => {
    const { fit, lenient } = fidelity(emotions, loose);
    expect(fit).toBeLessThan(FIT_GOOD); // not shown in order, translate or say
    expect(lenient).toBeGreaterThan(FIT_MIN); // but kept
  });

  it("another sentence is not a translation", () => {
    const other = fidelity(en("my dog like water"), pt("gato odeia leite"));
    expect(other.fit).toBe(0);
    expect(other.lenient).toBeLessThan(FIT_MIN);
  });

  it("a short idiom is loose but kept", () => {
    const idiom = fidelity(en("i be in trouble"), pt("estou em apuros"));
    expect(idiom.fit).toBe(0);
    expect(idiom.lenient).toBeGreaterThanOrEqual(FIT_MIN);
  });

  it("cognates count when the lemma is unknown", () => {
    expect(fidelity(en("you destroy everything"), pt("você destrói tudo")).fit).toBe(1);
  });

  it("negation on one side only costs", () => {
    const yes = fidelity(en("my dog like water"), pt("meu cachorro gosta de água")).fit;
    const no = fidelity(en("my dog like water"), pt("meu cachorro não gosta de água")).fit;
    expect(no).toBeLessThan(yes * 0.7);
  });

  it("the closest of several translations is kept; near ties keep the given order", () => {
    const options = [
      { text: "loose", fit: fidelity(emotions, loose).fit },
      { text: "closer", fit: fidelity(emotions, closer).fit },
    ];
    expect(closest(options)?.text).toBe("closer");
    // the first is the more Brazilian, shorter one: it stays unless another is 0.05 closer
    expect(
      closest([
        { fit: 0.81, n: 1 },
        { fit: 0.85, n: 2 },
      ])?.n,
    ).toBe(1);
    expect(
      closest([
        { fit: 0.81, n: 1 },
        { fit: 0.86, n: 2 },
      ])?.n,
    ).toBe(2);
    expect(closest([])).toBeUndefined();
  });

  it("the build reports the planner's threshold", () => {
    expect(FIT_GOOD).toBe(GOOD_FIT);
  });
});

describe("overrides", () => {
  const ids = new Set(["house.n", "dog.n", "fit.adj"]);

  it("parses glosses, alternatives and drops", () => {
    const map = parseOverrides(
      "house.n: {gloss: casa, alt: [lar]}\ndog.n: {alt: []}\nfit.adj: {drop: sentido ambíguo}\n",
      ids,
    );
    expect(map.get("house.n")).toEqual({ gloss: "casa", alt: ["lar"] });
    expect(map.get("dog.n")).toEqual({ alt: [] });
    expect(map.get("fit.adj")?.drop).toBe("sentido ambíguo");
    expect(parseOverrides("# nothing yet\n", ids).size).toBe(0);
  });

  it("an id that is not a word fails the build", () => {
    expect(() => parseOverrides("hous.n: {gloss: casa}\n", ids)).toThrow(
      /unknown word ids: hous\.n/,
    );
  });

  it("a malformed entry fails the build", () => {
    expect(() => parseOverrides("house.n: casa\n", ids)).toThrow(/overrides\.yaml/);
    expect(() => parseOverrides("house.n: {glos: casa}\n", ids)).toThrow(/overrides\.yaml/);
    expect(() => parseOverrides("house.n: {gloss: casa, drop: x}\n", ids)).toThrow(/drop/);
    // a gloss is a WhatsApp button title
    expect(() => parseOverrides("house.n: {gloss: casa muito muito grande}\n", ids)).toThrow();
    expect(() => parseOverrides("house.n: {gloss: casa}\nhouse.n: {gloss: lar}\n", ids)).toThrow();
  });

  it("data/course/overrides.yaml is well formed", () => {
    const text = readFileSync(path.join(PROJECT_ROOT, "data/course/overrides.yaml"), "utf8");
    const everything = { has: () => true } as unknown as ReadonlySet<string>;
    expect(parseOverrides(text, everything).size).toBeGreaterThan(30);
  });
});
