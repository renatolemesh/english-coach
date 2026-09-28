// The panel app without a database: routes that answer before any query.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { loadSettings } from "../../src/config.js";
import type { Db } from "../../src/db/client.js";
import { createPanel, landingPage } from "../../src/panel/index.js";
import { COOKIE, PRE_CSRF_COOKIE } from "../../src/panel/security.js";

const panel = createPanel({
  settings: loadSettings({}),
  cache: new MemoryCache(),
  db: {} as Db,
  connections: { list: async () => [], get: async () => null, setEnabled: async () => false },
  invalidateConnection: () => {},
});
const request = (path: string, init?: RequestInit) =>
  panel.request(`https://testserver${path.replace(/^\/panel/, "") || "/"}`, init);

describe("panel app", () => {
  it("adds the security headers to every response", async () => {
    const res = await request("/panel/static/panel.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const refused = await request("/panel/login", { method: "POST" });
    expect(refused.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves only the known static files", async () => {
    for (const [name, type] of [
      ["landing.css", "text/css"],
      ["card-sample.png", "image/png"],
      ["favicon.svg", "image/svg+xml"],
    ]) {
      const res = await request(`/panel/static/${name}`);
      expect([name, res.status, res.headers.get("content-type")?.split(";")[0]]).toEqual([
        name,
        200,
        type,
      ]);
    }
    expect((await request("/panel/static/landing.html")).status).toBe(404);
    expect((await request("/panel/static/..%2F..%2F.env")).status).toBe(404);
  });

  it("the landing page links to signup and has the panel's CSP", async () => {
    const page = landingPage(loadSettings({}, { publicBaseUrl: "https://saybest.test/" }))();
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain('href="/panel/signup"');
    expect(html).toContain('content="https://saybest.test/panel/static/card-sample.png"');
    expect(html).not.toContain("<script");
  });

  it("serves only the known font files", async () => {
    const font = await request("/panel/static/fonts/inter-latin-600-normal.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await request("/panel/static/fonts/..%2F..%2F.env")).status).toBe(404);
    expect((await request("/panel/static/fonts/other.woff2")).status).toBe(404);
  });

  it("pages before login set the double-submit cookie", async () => {
    const res = await request("/panel/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${PRE_CSRF_COOKIE}=`));
    expect(cookie).toMatch(/Path=\/panel/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/); // https
    const token = /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1];
    expect(cookie).toContain(`${PRE_CSRF_COOKIE}=${token}`);
  });

  it("a form without the csrf token is refused", async () => {
    const body = new URLSearchParams({ phone: "5511987654321", password: "x" });
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    const res = await request("/panel/login", { method: "POST", body, headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "invalid form, reload the page" });
    const wrong = await request("/panel/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: "a" }),
      headers: { ...headers, cookie: `${PRE_CSRF_COOKIE}=b` },
    });
    expect(wrong.status).toBe(403);
  });

  it("without a session the home goes to the login", async () => {
    const res = await request("/panel");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/panel/login");
    expect(COOKIE).toBe("sb_session");
    const mounted = new Hono().route("/panel", panel);
    for (const path of ["/panel", "/panel/"]) {
      const home = await mounted.request(`https://testserver${path}`);
      expect(home.status, path).toBe(303);
      expect(home.headers.get("location")).toBe("/panel/login");
    }
    expect((await mounted.request("https://testserver/panel/nope/")).status).toBe(404);
  });
});
