// Accounts through the graph (the WhatsApp gate and plan limits;
// phones, passwords and codes are in test/accounts/accounts.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/accounts/passwords.js";
import { defaultRuntimeConfig } from "../../src/accounts/runtime.js";
import * as verification from "../../src/accounts/verification.js";
import { StudentAccess } from "../../src/domain/accounts.js";
import { EN, formatText, PT } from "../../src/domain/texts.js";
import { CONN, Harness, PHONE, textMsg } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await Harness.create();
  h.repo.known = false; // the real policy: numbers must sign up first
  h.config = defaultRuntimeConfig(); // unknown_numbers="reject"
});

const welcomeStart = EN.welcome.split("{")[0] ?? "";

describe("accounts through the graph", () => {
  it("unknown numbers get the signup link once a day", async () => {
    await h.send(textMsg("hello", 1));
    expect(h.kinds()).toEqual(["text"]);
    expect(h.texts()[0]).toContain("/panel/signup");
    expect(h.llm.calls).toEqual([]);
    await h.send(textMsg("hello again", 2));
    expect(h.channel.sent).toEqual([]); // already told today
  });

  it("trial policy lets new numbers in", async () => {
    h.config = { ...defaultRuntimeConfig(), unknown_numbers: "trial" };
    await h.send(textMsg("hello", 1));
    expect(h.texts()[0]?.startsWith(welcomeStart)).toBe(true); // first contact: welcome
    expect(h.repo.access.get(1)?.plan_name).toBe("Teste Ilimitado");
  });

  it("signup code creates the account and starts", async () => {
    const cache = h.container.cache;
    const token = verification.newToken();
    const pending = {
      kind: "signup" as const,
      token,
      phone: PHONE,
      name: "Ana",
      password_hash: await hashPassword("secret123"),
    };
    const code = await verification.start(cache, pending);
    const state = await h.send(textMsg(`ATIVAR ${code}`, 1));
    expect(h.texts()[0]?.startsWith(welcomeStart)).toBe(true); // the /start welcome
    expect(["voice", "choice"]).toContain(h.kinds().at(-1));
    const status = await verification.status(cache, token);
    expect(status.status).toBe("done");
    expect(status.user_id).toBe(state.user_id);
    const userId = state.user_id as number;
    expect(await verifyPassword("secret123", h.repo.passwords.get(userId))).toBe(true);
  });

  it("a code from another number is refused", async () => {
    const token = verification.newToken();
    const code = await verification.start(h.container.cache, {
      kind: "signup",
      token,
      phone: "11999990000",
    });
    await h.send(textMsg(`ATIVAR ${code}`, 1));
    expect(h.texts()).toEqual([EN.codeWrongPhone]);
    expect((await verification.status(h.container.cache, token)).status).toBe("wrong_phone");
    await h.send(textMsg("ATIVAR 000000", 2));
    expect(h.texts()).toEqual([EN.codeUnknown]);
  });

  it("reset code confirms the token", async () => {
    const access = await h.repo.createStudent(CONN, PHONE, "Básico");
    const token = verification.newToken();
    const code = await verification.start(h.container.cache, {
      kind: "reset",
      token,
      phone: PHONE,
      user_id: access.user_id,
      lang: "pt",
    });
    await h.send(textMsg(`SENHA ${code}`, 1));
    expect(h.texts()).toEqual([PT.resetConfirmed]);
    expect((await verification.status(h.container.cache, token)).status).toBe("done");
  });

  it("blocked and expired students are refused", async () => {
    const repo = h.repo;
    const access = await repo.createStudent(CONN, PHONE, "Grátis");
    repo.access.set(access.user_id, { ...access, status: "blocked" });
    await h.send(textMsg("hi", 1));
    expect(h.texts()[0]?.startsWith("Your account is paused")).toBe(true);
    const ended = new Date(Date.now() - 24 * 3600 * 1000);
    repo.access.set(access.user_id, { ...access, plan_ends_at: ended });
    await h.send(textMsg("hi", 2));
    expect(h.texts()[0]?.startsWith("Your plan has ended")).toBe(true);
    expect(h.llm.calls).toEqual([]);
  });

  it("the daily limit of the plan", async () => {
    const repo = h.repo;
    const access = await repo.createStudent(CONN, PHONE, "Grátis");
    repo.access.set(access.user_id, { ...access, messages_per_day: 3 });
    await h.send(textMsg("hi", 1)); // first contact: welcome + opener (an LLM call: counts)
    for (const n of [2, 3]) {
      await h.send(textMsg(`I like trains ${n}`, n));
      expect(h.kinds()[0]).toBe("image");
    }
    await h.send(textMsg("/menu", 4)); // menus do not count either
    expect(h.channel.sent[0]?.text ?? "").toContain("0 messages left today");
    await h.send(textMsg("I like buses", 5));
    expect(h.texts()).toEqual([formatText(EN.blocked.daily_limit as string, { limit: 3 })]);
  });

  it("preferences saved by the panel reach the conversation", async () => {
    const repo = h.repo;
    const access = await repo.createStudent(CONN, PHONE, "Ilimitado");
    repo.access.set(
      access.user_id,
      StudentAccess.parse({ user_id: access.user_id, ui_lang: "pt", tutor: "george", speed: 0.8 }),
    );
    const state = await h.send(textMsg("/ajuda", 1));
    expect(h.texts()).toEqual([PT.help]);
    expect([state.tutor, state.speed]).toEqual(["george", 0.8]);
    await h.send(textMsg("/voz sarah", 2)); // and WhatsApp changes go back to the student
    expect(repo.access.get(access.user_id)?.tutor).toBe("sarah");
  });
});
