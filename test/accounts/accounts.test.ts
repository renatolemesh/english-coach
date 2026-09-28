// Accounts: phones, passwords, verification codes and runtime config (no graph needed).
import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../../src/accounts/passwords.js";
import { fromForm, normalize, samePhone, variants } from "../../src/accounts/phones.js";
import { defaultRuntimeConfig, RuntimeConfigSchema } from "../../src/accounts/runtime.js";
import * as verification from "../../src/accounts/verification.js";
import { MemoryCache } from "../../src/adapters/cache/memory.js";

// Reference hashes in the stored format: scrypt(password as UTF-8, salt, N=2^14, r=8, p=1,
// 32-byte key). Existing passwords in the database look like these.
const REFERENCE_HASHES: [string, string][] = [
  [
    "correct horse",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$" +
      "f5206d570fcd120bd1f23a8cd186bd87c04ac1db00e9ac1efca589774ae6ecb8",
  ],
  [
    "senha çãé 🔑",
    "scrypt$16384$8$1$00112233445566778899aabbccddeeff$" +
      "e9246f004e0d67c25e61cfbb1ed7d7678cad404f5682b2918bc1972079c4fed2",
  ],
];

describe("phones", () => {
  it("brazilian numbers match with or without the ninth digit", () => {
    expect(variants("5511987654321")).toEqual(["5511987654321", "551187654321"]);
    expect(samePhone("+55 11 98765-4321", "551187654321")).toBe(true); // how WhatsApp sends it
    expect(samePhone("+55 11 98765-4321", "551187654322")).toBe(false);
    expect(variants("551187654321")).toEqual(["551187654321", "5511987654321"]);
    expect(normalize("+44 20 7946 0958")).toBe("442079460958");
    expect(normalize("+1 (415) 555-0100")).toBe("14155550100"); // no 55 added to other countries
  });

  it("forms take only complete numbers: country code, area code and number", () => {
    expect(fromForm("+55 (11) 98765-4321")).toBe("5511987654321");
    expect(fromForm("5511987654321")).toBe("5511987654321");
    expect(fromForm("55 11 8765-4321")).toBe("5511987654321"); // mobile without the 9: added
    expect(fromForm("+55 41 3333-4444")).toBe("554133334444"); // landline: kept
    expect(fromForm("0055 11 98765-4321")).toBe("5511987654321");
    expect(fromForm("+1 (415) 555-0100")).toBe("14155550100");
    expect(fromForm("+44 20 7946 0958")).toBe("442079460958");
    expect(fromForm("11 98765-4321")).toBeNull(); // no country code
    expect(fromForm("(11) 8765-4321")).toBeNull();
    expect(fromForm("55 98765-4321")).toBeNull(); // DDD 55 without the country code
    expect(fromForm("14155550100")).toBeNull(); // another country needs the "+"
    expect(fromForm("123")).toBeNull();
    expect(fromForm("")).toBeNull();
  });
});

describe("passwords", () => {
  it("passwords are salted scrypt", async () => {
    const stored = await hashPassword("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toBe(await hashPassword("correct horse"));
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(passwordProblem("short")).toBe("too_short");
    expect(passwordProblem("long enough")).toBeNull();
    expect(passwordProblem("x".repeat(129))).toBe("too_long");
  });

  it("verifies reference hashes in the stored format", async () => {
    for (const [password, stored] of REFERENCE_HASHES) {
      expect(await verifyPassword(password, stored)).toBe(true);
      expect(await verifyPassword(`${password}!`, stored)).toBe(false);
    }
  });

  it("uses the same format and parameters", async () => {
    const [scheme, n, r, p, salt, digest] = (await hashPassword("abc")).split("$");
    expect([scheme, n, r, p]).toEqual(["scrypt", "16384", "8", "1"]);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses malformed hashes", async () => {
    const good = REFERENCE_HASHES[0]?.[1] ?? "";
    for (const bad of [
      "",
      "bcrypt$16384$8$1$00$00",
      good.replace("scrypt$16384", "scrypt$1000"), // N not a power of 2
      good.replace("00112233", "zz112233"),
      `${good}$extra`,
      good.toUpperCase().replace("SCRYPT", "scrypt"), // hex must be lowercase
    ]) {
      expect(await verifyPassword("correct horse", bad), bad).toBe(false);
    }
    expect(await verifyPassword("x".repeat(129), good)).toBe(false);
  });
});

describe("verification codes", () => {
  it("a code works once", async () => {
    const cache = new MemoryCache();
    const token = verification.newToken();
    const code = await verification.start(cache, {
      kind: "signup",
      token,
      phone: "11987654321",
    });
    expect(code).toMatch(/^\d{6}$/);
    expect(verification.parse(`ATIVAR ${code}`)).toEqual(["signup", code]);
    expect(verification.parse(`/activate: ${code}.`)).toEqual(["signup", code]);
    expect(verification.parse("ativar agora")).toBeNull();
    expect(verification.parse(`senha #${code}!`)).toEqual(["reset", code]);
    const pending = await verification.claim(cache, "signup", code);
    expect(pending).toMatchObject({ kind: "signup", token, phone: "11987654321", lang: "en" });
    expect(await verification.claim(cache, "signup", code)).toBeNull();
    expect((await verification.status(cache, token)).status).toBe("pending");
  });

  it("status is expired for unknown tokens and stores what is set", async () => {
    const cache = new MemoryCache();
    expect(await verification.status(cache, "nope")).toEqual({ status: "expired", user_id: null });
    await verification.setStatus(cache, "t", { status: "done", user_id: 7 });
    expect(await verification.status(cache, "t")).toEqual({ status: "done", user_id: 7 });
    expect(await verification.claim(cache, "reset", "123456")).toBeNull();
    expect(verification.newToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("stores verification JSON in the expected shape", async () => {
    const cache = new MemoryCache();
    const code = await verification.start(cache, {
      kind: "reset",
      token: "tk",
      phone: "1",
      user_id: 3,
    });
    const raw = await cache.get(`verify:code:reset:${code}`);
    expect(raw?.toString()).toBe(
      '{"kind":"reset","token":"tk","phone":"1","name":"","password_hash":"","user_id":3,"lang":"en"}',
    );
    expect((await cache.get("verify:token:tk"))?.toString()).toBe(
      '{"status":"pending","user_id":null}',
    );
  });
});

describe("runtime config", () => {
  it("has the expected defaults (default tutor: Sarah)", () => {
    expect(defaultRuntimeConfig()).toEqual({
      unknown_numbers: "reject",
      signup_enabled: true,
      trial_plan: "Teste Ilimitado",
      whatsapp_number: "",
      signup_connection: "meta-main",
      contact_text: "",
      rate_limit_per_minute: null,
      session_idle_hours: 12,
      default_ui_lang: "en",
      default_tutor: "sarah",
      timezone: "America/Sao_Paulo",
    });
  });

  it("validates like the panel expects", () => {
    const parsed = RuntimeConfigSchema.parse({
      rate_limit_per_minute: "9",
      session_idle_hours: "0.5",
    });
    expect(parsed.rate_limit_per_minute).toBe(9);
    expect(parsed.session_idle_hours).toBe(0.5);
    expect(RuntimeConfigSchema.parse({ unknown_numbers: "trial" }).unknown_numbers).toBe("trial");
    for (const bad of [
      { rate_limit_per_minute: 0 },
      { rate_limit_per_minute: 61 },
      { session_idle_hours: 721 },
      { session_idle_hours: "" },
      { default_tutor: "bob" },
    ]) {
      expect(RuntimeConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(RuntimeConfigSchema.shape.signup_enabled.description).toBe(
      "Permite cadastro pelo site.",
    );
  });
});
