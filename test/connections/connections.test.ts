import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { EvolutionChannel } from "../../src/adapters/channels/evolution.js";
import { buildChannel, missingFields } from "../../src/adapters/channels/registry.js";
import { loadSettings, PROJECT_ROOT, Secret } from "../../src/config.js";
import { CredentialCipher, Fernet } from "../../src/connections/crypto.js";
import { ChannelPool } from "../../src/connections/pool.js";
import { MemoryConnectionStore } from "../../src/connections/store.js";
import { loadConnectionsYaml } from "../../src/connections/yaml-loader.js";
import { ConnectionConfig, connectionSecret } from "../../src/domain/connections.js";
import { evoConn, metaConn } from "../channels/helpers.js";

const settings = loadSettings({}, { env: "test", useFakes: true });

// Reference Fernet tokens (spec-compatible; stored credentials look like these).
const REF_KEY = "UcbTvSe_fK1HGKQnIEL5K8yZ9iC7ImNTxkNq6M8OD7Y=";
// Plaintext '{"api_key": "abc", "x": "\u00e7\u00e3o \u2705"}' at time 1790000000 (seconds)
// with IV 00 01 ... 0f.
const REF_FIXED =
  "gAAAAABqsTuAAAECAwQFBgcICQoLDA0OD168YmOYNBh3Fo2kyVZvv_oowRV1VpGWTomR9RqQ7qMJcIOOPY71eQpSMD5NKB63NiSbroPjiVNrXcSoDFCS6Ov8QvRXBCUXZIbBedcl7AZ7";
// Credentials {api_key: "evo-key", note: "ação 😀"} encrypted with the same key (random time/IV).
const REF_CREDENTIALS =
  "gAAAAABquanxPQ2G8yYaokdhEjaqecVIjIpcF8Jx-QmOoKh_wZr-g6xfH4Yn45WmhC3V4Xt49GKIn-f6CXSwMm2hUE4KbBAmzsC7_CkGRg7IrKiJFX55duqNBnu6c8bsALpXy1flLHar8EimVNudl2acZ6mPegd9qA==";

describe("connections", () => {
  it("cipher roundtrip and wrong key", () => {
    const cipher = new CredentialCipher(Fernet.generateKey());
    const token = cipher.encrypt({ api_key: new Secret("abc") });
    expect(token).not.toContain("abc");
    expect(cipher.decrypt(token).api_key?.value).toBe("abc");
    expect(() => new CredentialCipher(Fernet.generateKey()).decrypt(token)).toThrow(/FERNET_KEY/);
    expect(() => new CredentialCipher("")).toThrow(/FERNET_KEY/);
  });

  it("fernet tokens match the reference tokens both ways", () => {
    const fernet = new Fernet(REF_KEY);
    // reference -> decrypt
    expect(fernet.decrypt(REF_FIXED).toString("utf8")).toBe(
      '{"api_key": "abc", "x": "\\u00e7\\u00e3o \\u2705"}',
    );
    const creds = new CredentialCipher(REF_KEY).decrypt(REF_CREDENTIALS);
    expect(creds.api_key?.value).toBe("evo-key");
    expect(creds.note?.value).toBe("ação 😀");
    // encrypt -> the same bytes as the reference for the same time and IV
    const iv = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const again = new CredentialCipher(REF_KEY);
    const plain = fernet.decrypt(
      again.encrypt({ api_key: new Secret("abc"), x: new Secret("ção ✅") }),
    );
    expect(fernet.encrypt(plain, 1_790_000_000_000, iv)).toBe(REF_FIXED);
    // tampering is detected
    const bad = `${REF_FIXED.slice(0, 60)}${REF_FIXED[60] === "A" ? "B" : "A"}${REF_FIXED.slice(61)}`;
    expect(() => fernet.decrypt(bad)).toThrow();
  });

  it("secrets never in repr", () => {
    const conn = evoConn();
    expect(JSON.stringify(conn)).not.toContain("evo-key");
    expect(inspect(conn, { depth: 10 })).not.toContain("evo-key");
    expect(String(conn.webhook_secret)).not.toContain("hook-secret");
  });

  it("registry validates required fields", () => {
    expect(missingFields(metaConn())).toEqual([]);
    const broken = evoConn({ webhook_secret: "", settings: { instance: "x" } });
    expect(missingFields(broken)).toEqual(["settings.base_url", "webhook_secret"]);
    expect(() => buildChannel(broken, settings)).toThrow(/missing/);
    expect(buildChannel(evoConn(), settings)).toBeInstanceOf(EvolutionChannel);
  });

  it("stub providers fail loudly", () => {
    const waha = buildChannel(
      ConnectionConfig.parse({ id: "w-1", name: "w", provider: "waha" }),
      settings,
    );
    expect(() => waha.parseWebhook({}, Buffer.from("{}"))).toThrow(/waha/);
  });

  it("yaml loader expands env", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "conn-")), "connections.yaml");
    writeFileSync(
      file,
      "connections:\n" +
        "  - id: evo-main\n    name: Evo\n    provider: evolution\n" +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} syntax under test
        "    webhook_secret: s\n    credentials: {api_key: '${EVO_KEY}'}\n" +
        "    settings: {base_url: 'http://e', instance: coach}\n",
    );
    const env = { EVO_KEY: "from-env" };
    const [conn] = loadConnectionsYaml(file, env);
    expect(conn && connectionSecret(conn, "api_key")).toBe("from-env");
    writeFileSync(file, readFileSync(file, "utf8").replace("EVO_KEY", "MISSING_VAR_X"));
    expect(() => loadConnectionsYaml(file, env)).toThrow(/MISSING_VAR_X/);
  });

  it("the example connections.yaml loads", () => {
    const env = {
      META_ACCESS_TOKEN: "t",
      META_APP_SECRET: "a",
      META_VERIFY_TOKEN: "v",
      EVO_WEBHOOK_SECRET: "w",
      EVO_API_KEY: "k",
    };
    const example = path.join(PROJECT_ROOT, "connections.example.yaml");
    const conns = loadConnectionsYaml(example, env);
    expect(conns.map((c) => [c.id, c.provider, missingFields(c)])).toEqual([
      ["meta-main", "meta", []],
      ["evo-main", "evolution", []],
    ]);
    expect(conns[0]?.settings.phone_number_id).toBe("106540352242922");
  });

  it("pool caches and hides disabled", async () => {
    const store = new MemoryConnectionStore(evoConn(), metaConn({ id: "off-1", enabled: false }));
    const pool = new ChannelPool(store, settings);
    const first = await pool.get("evo-main");
    const second = await pool.get("evo-main");
    expect(first && second && first[1] === second[1]).toBe(true);
    expect(store.gets).toBe(1);
    expect(await pool.get("off-1")).toBeNull();
    expect(await pool.get("unknown")).toBeNull();
    await pool.close();
  });

  it("pool does not close channels still in use", async () => {
    const store = new MemoryConnectionStore(evoConn());
    const pool = new ChannelPool(store, settings, 0.0, 3600);
    const first = await pool.get("evo-main");
    expect(first).not.toBeNull();
    const same = await pool.get("evo-main"); // config unchanged: same channel reused
    expect(same?.[1]).toBe(first?.[1]);
    store.conns.set(
      "evo-main",
      evoConn({ settings: { base_url: "http://other", instance: "coach" } }),
    );
    const changed = await pool.get("evo-main");
    expect(changed && changed[1] !== first?.[1]).toBe(true);
    const http = (first as NonNullable<typeof first>)[1] as EvolutionChannel;
    const client = http.http;
    expect(client.closed).toBe(false); // in-flight safe
    await pool.close();
    expect(client.closed).toBe(true);
  });
});
