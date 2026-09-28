import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import {
  checkCsrf,
  MAX_FAILS_PER_ID,
  MAX_FAILS_PER_IP,
  MAX_SIGNUPS_PER_IP,
  Session,
  Throttle,
  tokenUrlsafe,
} from "../../src/panel/security.js";

describe("csrf", () => {
  it("compares the session token with the posted one", () => {
    const token = tokenUrlsafe(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(checkCsrf(token, token)).toBe(true);
    expect(checkCsrf(token, `${token}x`)).toBe(false); // other length
    expect(
      checkCsrf(
        token,
        token.replace(/.$/, (ch) => (ch === "a" ? "b" : "a")),
      ),
    ).toBe(false);
  });

  it("refuses when either side is missing", () => {
    expect(checkCsrf("", "")).toBe(false);
    expect(checkCsrf(null, "x")).toBe(false);
    expect(checkCsrf("x", undefined)).toBe(false);
  });
});

describe("throttle", () => {
  it("blocks an identifier after MAX_FAILS_PER_ID failures, and a success clears it", async () => {
    const throttle = new Throttle(new MemoryCache());
    for (let i = 0; i < MAX_FAILS_PER_ID - 1; i++) await throttle.failed("1.2.3.4", "5541");
    expect(await throttle.blocked("1.2.3.4", "5541")).toBe(false);
    await throttle.failed("1.2.3.4", "5541");
    expect(await throttle.blocked("1.2.3.4", "5541")).toBe(true);
    expect(await throttle.blocked("1.2.3.4", "other")).toBe(false); // the IP is still under
    await throttle.succeeded("5541");
    expect(await throttle.blocked("1.2.3.4", "5541")).toBe(false);
  });

  it("blocks an IP after MAX_FAILS_PER_IP failures on any identifier", async () => {
    const throttle = new Throttle(new MemoryCache());
    for (let i = 0; i < MAX_FAILS_PER_IP; i++) await throttle.failed("9.9.9.9", `id${i}`);
    expect(await throttle.blocked("9.9.9.9", "fresh")).toBe(true);
    expect(await throttle.blocked("8.8.8.8", "fresh")).toBe(false);
  });

  it("allows MAX_SIGNUPS_PER_IP signups per IP", async () => {
    const throttle = new Throttle(new MemoryCache());
    const results: boolean[] = [];
    for (let i = 0; i <= MAX_SIGNUPS_PER_IP; i++) results.push(await throttle.signupAllowed("ip"));
    expect(results).toEqual([true, true, true, true, true, false]);
    expect(await throttle.signupAllowed("other")).toBe(true);
  });
});

describe("session", () => {
  it("knows admins from staff and names the actor", () => {
    const session = new Session("h", "admin", "c");
    expect(session.actor).toBe("student:?");
    session.admin = { role: "staff", email: "a@b.c" } as Session["admin"];
    expect(session.isAdmin).toBe(false);
    expect(session.actor).toBe("staff:a@b.c");
    session.admin = { role: "admin", email: "a@b.c" } as Session["admin"];
    expect(session.isAdmin).toBe(true);
  });
});
