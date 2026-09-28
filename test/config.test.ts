import { describe, expect, it } from "vitest";
import { fallbackModels, loadSettings, Secret } from "../src/config.js";
import { redactSecrets } from "../src/logging.js";

describe("settings", () => {
  it("reads UPPER_SNAKE env vars with defaults (STT thresholds: whisper.cpp scale)", () => {
    const s = loadSettings({ RATE_LIMIT_PER_MINUTE: "9", USE_FAKES: "true", FERNET_KEY: "k" });
    expect(s.rateLimitPerMinute).toBe(9);
    expect(s.useFakes).toBe(true);
    expect(s.sttMinConfidence).toBe(-2); // whisper.cpp scale
    expect(fallbackModels(s)).toHaveLength(2);
  });

  it("never prints secrets", () => {
    const s = loadSettings({ OPENROUTER_API_KEY: "sk-secret" });
    expect(s.openrouterApiKey.value).toBe("sk-secret");
    expect(JSON.stringify(s)).not.toContain("sk-secret");
    expect(`${new Secret("x")}`).toBe("***");
  });

  it("redacts the Meta verify token from logged URLs", () => {
    expect(redactSecrets("GET /webhooks/x?hub.verify_token=abc&hub.challenge=1")).toBe(
      "GET /webhooks/x?hub.verify_token=***&hub.challenge=1",
    );
  });
});
