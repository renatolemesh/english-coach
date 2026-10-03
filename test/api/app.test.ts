import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { serveAppWeb } from "../../src/api/app.js";
import { buildContainer, Container } from "../../src/container.js";
import { makeClient, testSettings } from "./helpers.js";

describe("app", () => {
  it("health", async () => {
    const resp = await makeClient().request("/health");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: "ok", redis: "n/a" });
  });

  it("container uses fakes in tests", async () => {
    const container = await buildContainer(testSettings());
    expect(container).toBeInstanceOf(Container);
    expect(container.cache.constructor.name).toBe("MemoryCache");
  });

  it("unknown routes are 404", async () => {
    expect((await makeClient().request("/nope")).status).toBe(404);
  });

  it("the web app: files from the build, index.html for its routes, its own CSP", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "app-web-"));
    writeFileSync(path.join(dir, "index.html"), "<html>saybest</html>");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "main.dart.js"), "main();");
    const app = new Hono();
    serveAppWeb(app, dir);
    app.get("/app/v1/me", (c) => c.json({ api: true }));
    const js = await app.request("/app/main.dart.js");
    expect([js.status, await js.text()]).toEqual([200, "main();"]);
    expect(js.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    const route = await app.request("/app/progress");
    expect([route.status, await route.text()]).toEqual([200, "<html>saybest</html>"]);
    expect(route.headers.get("cache-control")).toBe("no-cache");
    expect(await (await app.request("/app/v1/me")).json()).toEqual({ api: true });
    expect((await app.request("/app")).status).toBe(301);
  });
});
