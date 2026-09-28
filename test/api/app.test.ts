import { describe, expect, it } from "vitest";
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
});
