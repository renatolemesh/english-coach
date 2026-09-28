// The pure output-rule tests (the node-level ones are in test/graph/nodes.test.ts).
import { describe, expect, it } from "vitest";
import {
  countQuestions,
  dropEchoes,
  dropInventedExperiences,
  ensureQuestion,
  oneQuestion,
  repeatsQuestion,
  shorten,
} from "../../src/guardrails/output-rules.js";

describe("one question", () => {
  it("only one trailing question is kept", () => {
    expect(oneQuestion("What part do you work in? And after work, any hobbies?")).toBe(
      "What part do you work in?",
    );
    expect(oneQuestion("Oh, really? Nice! What do you do?")).toBe(
      "Oh, really? Nice! What do you do?",
    );
  });

  it("a second question glued with and is cut", () => {
    expect(oneQuestion("Oh wow! How was the weather and what did you do there?")).toBe(
      "Oh wow! How was the weather?",
    );
    const kept = "Do you prefer beaches or mountains, or do you like both?"; // alternatives are fine
    expect(oneQuestion(kept)).toBe(kept);
  });

  it.each([
    [
      "Where did you go? Was it a fun weekend? I love the beach. Did you swim?",
      "I love the beach. Did you swim?",
    ],
    [
      "Oh, you went to Rio last year? Cool! What did you like most?",
      "Oh, you went to Rio last year? Cool! What did you like most?",
    ],
    ["Oh, really? That is cool! What do you do?", "Oh, really? That is cool! What do you do?"],
    ["What part do you work in? And after work, any hobbies?", "What part do you work in?"],
    ["Tell me about a place you love.", "Tell me about a place you love."],
  ])("one real question is kept: %s", (reply, expected) => {
    expect(oneQuestion(reply)).toBe(expected);
    expect(countQuestions(oneQuestion(reply))).toBeLessThanOrEqual(1);
  });

  // Real openers from eval round 6 that the old trimming damaged.
  it.each([
    [
      "Hey! What do you do for a living these days? I have been working as a graphic " +
        "designer for about three years now.",
      "Hey! What do you do for a living these days?",
    ],
    [
      "Hey! I love traveling. Do you usually go by plane, car, or bus? What do you prefer?",
      "Hey! I love traveling. Do you usually go by plane, car, or bus?",
    ],
    [
      "Hey! Do you usually travel by plane, car, or bus? Which one do you prefer and why?",
      "Hey! Do you usually travel by plane, car, or bus?",
    ],
    [
      "Hi! So, what's your city like? What do you enjoy most about living there?",
      "Hi! So, what's your city like?",
    ],
  ])("the concrete question is kept: %s", (opener, expected) => {
    expect(oneQuestion(opener)).toBe(expected);
  });

  it("single questions and innocent sentences survive", () => {
    const longOne = "What do you like to do when you are tired and have some free time?";
    expect(oneQuestion(longOne)).toBe(longOne);
    expect(oneQuestion("Nice! Was the hotel big and did you like it?")).toBe(
      "Nice! Was the hotel big?",
    );
    const text = "I think that is too expensive. I did not know that! What do you think?";
    expect(dropInventedExperiences(text)).toBe(text);
  });

  // Round-7 cases: openers keep the first (concrete) question; And-questions lean.
  it("round7 question choices", () => {
    const opener =
      "Hey! So, do you usually travel by plane, car, or bus? What do you prefer and why?";
    expect(oneQuestion(opener, true)).toBe("Hey! So, do you usually travel by plane, car, or bus?");
    const reply =
      "Hey! So, what do you do for a living these days? And how long have you been in " +
      "that line of work?";
    expect(oneQuestion(reply)).toBe("Hey! So, what do you do for a living these days?");
    const two = "Currently, what kind of software do you work with? Do you enjoy coding?";
    expect(oneQuestion(two)).toBe("Do you enjoy coding?");
  });

  it("what about you is not the question kept", () => {
    const opener = "Hey! I'm Emma, a designer. What about you? What do you do for work or study?";
    expect(oneQuestion(opener, true)).toBe(
      "Hey! I'm Emma, a designer. What do you do for work or study?",
    );
  });

  it("choice questions count and learning claims are dropped", () => {
    const text =
      "Oh, a software engineer! So you build apps or websites? How long have you worked?";
    expect(oneQuestion(text)).toBe("Oh, a software engineer! How long have you worked?");
    expect(
      dropInventedExperiences(
        "Cool! I'm currently learning some coding myself. What do you build?",
      ),
    ).toBe("Cool! What do you build?");
  });

  it("options stay with their open question and live memories are dropped", () => {
    const text =
      "Got it, about two years! So, what do you do after work to relax? " +
      "Do you watch a series or maybe go for a run?";
    expect(oneQuestion(text)).toBe(
      "Got it, about two years! So, what do you do after work to relax?",
    );
    const show =
      "It was amazing, wasn't it? I still can't believe how loud they were live. " +
      "Did you play any of their songs after that?";
    expect(dropInventedExperiences(show)).not.toContain("can't believe");
  });

  it("me too mid sentence and openers whose questions all lean", () => {
    const text =
      "Oh, that sounds like a wonderful plan! I intend to travel to Europe too, I've always wanted to see Prague. Which countries are you thinking of?";
    expect(dropInventedExperiences(text)).toBe(
      "Oh, that sounds like a wonderful plan! Which countries are you thinking of?",
    );
    const opener =
      "Hey there! I'm Emma. What about you? Tell me about your city. " +
      "What do you like about living there?";
    expect(
      oneQuestion(opener, true).endsWith(
        "Tell me about your city. What do you like about living there?",
      ),
    ).toBe(true);
  });
});

describe("invented experiences and echoes", () => {
  it("invented experiences are removed but persona stays", () => {
    expect(
      dropInventedExperiences(
        "Oh, great band! I have seen them live in Toronto. What's your favorite song?",
      ),
    ).toBe("Oh, great band! What's your favorite song?");
    const kept = "Oh nice, I love cooking too! What do you like to cook?";
    expect(dropInventedExperiences(kept)).toBe(kept);
  });

  it("quoted examples are not experiences", () => {
    const text = "We say 'make a mistake', you don't say 'I did a mistake'. Does that make sense?";
    expect(dropInventedExperiences(text)).toBe(text);
  });

  it("the tutor never says the students line as their own", () => {
    const said = ["I want a pizza and a coke please", "I'd like a pizza and a coke, please."];
    const waiter = "Great choice! I'd like a pizza and a coke, please. Anything else for you?";
    expect(dropEchoes(waiter, said)).toBe("Great choice! Anything else for you?");
    const recast = "Oh, you want a pizza and a coke? Coming right up. Anything else?";
    expect(dropEchoes(recast, said)).toBe(recast); // a reaction, not the student's line
    const own = "I love pizza with extra cheese. What's your favorite topping?";
    expect(dropEchoes(own, said)).toBe(own);
  });
});

describe("openers and questions", () => {
  it("long openers keep the start and the question", () => {
    const long =
      "Hi! I'm Emma, I'm 29 and I'm from Bristol, England, but I live in Toronto now. " +
      "I work as a graphic designer and I love cooking, hiking and indie rock. " +
      "I also have a cat called Pixel. So, tell me, where are you from?";
    const short = shorten(long, 200);
    expect(short.length).toBeLessThanOrEqual(200);
    expect(short.startsWith("Hi! I'm Emma")).toBe(true);
    expect(short.endsWith("from?")).toBe(true);
  });

  it("requests become questions and echoes go", () => {
    expect(ensureQuestion("Hi! I'm Emma. Tell me about your city.")).toBe(
      "Hi! I'm Emma. Can you tell me about your city?",
    );
    expect(ensureQuestion("Nice. See you!", null)).toBe("Nice. See you!");
    expect(ensureQuestion("It becomes natural!")).toBe("It becomes natural! What about you?");
    const kept = "Hey! Plane or car, what do you think is more fun, and why?"; // one question
    expect(oneQuestion(kept)).toBe(kept);
    expect(
      dropInventedExperiences(
        "Cool! You said you play since you were fifteen. What songs do you play?",
      ),
    ).toBe("Cool! What songs do you play?");
  });
});

// Real conversation (26/09): the student's answer to "How long...?" was garbled by the audio.
const ASKED = "How long have you been working as a software engineer?";
const AGAIN =
  "Ah, web development, nice! So you build websites. How long have you been working in web development?";

describe("repeated questions", () => {
  it("a question already asked is detected", () => {
    expect(repeatsQuestion(AGAIN, [ASKED])).toBe(true);
    expect(
      repeatsQuestion("Nice! How long have you been working as a software engineer?", [ASKED]),
    ).toBe(true);
    for (const fresh of [
      "Cool! What do you like most about your job?",
      "Nice. Is it hard?",
      "Oh, so you work from home?",
    ]) {
      expect(repeatsQuestion(fresh, [ASKED]), fresh).toBe(false);
    }
    expect(repeatsQuestion("What did you eat for dinner?", ["What did you do on Sunday?"])).toBe(
      false,
    );
  });
});
