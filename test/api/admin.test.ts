import { afterEach, describe, expect, it, vi } from "vitest";
import { Secret } from "../../src/config.js";
import { FetchMock } from "../channels/helpers.js";
import { type Client, makeClient } from "./helpers.js";

const AUTH = { "x-api-key": "admin-key" };
const NEW = {
  id: "evo-2",
  name: "Segunda",
  provider: "evolution",
  webhook_secret: "ws",
  credentials: { api_key: "k2" },
  settings: { base_url: "http://evolution.test", instance: "coach2" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const send = (client: Client, method: string, path: string, body?: unknown, headers = AUTH) =>
  client.request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("admin API", () => {
  it("admin requires api key", async () => {
    const client = makeClient();
    expect((await client.request("/admin/connections")).status).toBe(401);
    const wrong = await client.request("/admin/connections", { headers: { "x-api-key": "nope" } });
    expect(wrong.status).toBe(401);
    expect((await client.request("/admin/connections", { headers: AUTH })).status).toBe(200);
  });

  it("admin api is disabled without a key", async () => {
    const client = makeClient();
    client.state.settings = { ...client.state.settings, adminApiKey: new Secret("") };
    expect((await client.request("/admin/connections", { headers: AUTH })).status).toBe(503);
  });

  it("list never returns secrets", async () => {
    const client = makeClient();
    const body = await (await client.request("/admin/connections", { headers: AUTH })).text();
    for (const secret of ["evo-key", "s3cret", "hook-secret", "EAAG-token", "verify-me"]) {
      expect(body).not.toContain(secret);
    }
    expect(body).toContain("https://saybest.example/webhooks/evo-main");
  });

  it("create validate and conflict", async () => {
    const client = makeClient();
    const created = await send(client, "POST", "/admin/connections", NEW);
    expect(created.status).toBe(201);
    const out = (await created.json()) as { credential_keys: string[]; missing: string[] };
    expect(out.credential_keys).toEqual(["api_key"]);
    expect(out.missing).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("k2");
    expect((await send(client, "POST", "/admin/connections", NEW)).status).toBe(409);
    const incomplete = { ...NEW, id: "evo-3", settings: { instance: "x" } };
    const resp = await send(client, "POST", "/admin/connections", incomplete);
    expect(resp.status).toBe(422);
    expect(await resp.text()).toContain("settings.base_url");
    const typo = await send(client, "POST", "/admin/connections", {
      ...NEW,
      id: "evo-4",
      nme: "x",
    });
    expect(typo.status).toBe(422); // a typo must fail, not be silently ignored
  });

  it("patch merges and disable stops webhooks", async () => {
    const client = makeClient();
    const patched = await send(client, "PATCH", "/admin/connections/evo-main", {
      name: "Renomeada",
      settings: { instance: "coach" },
    });
    const body = (await patched.json()) as { name: string; settings: Record<string, unknown> };
    expect(body.name).toBe("Renomeada");
    expect(body.settings.base_url).toBe("http://evolution.test"); // kept
    const disabled = await send(client, "POST", "/admin/connections/evo-main/disable");
    expect(((await disabled.json()) as { enabled: boolean }).enabled).toBe(false);
    const hook = await client.request("/webhooks/evo-main", { method: "POST", body: "{}" });
    expect(hook.status).toBe(404); // pool refreshed
    const enabled = await send(client, "POST", "/admin/connections/evo-main/enable");
    expect(((await enabled.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  it("patch removes credentials with empty strings and settings with null", async () => {
    const client = makeClient();
    const resp = await send(client, "PATCH", "/admin/connections/meta-main", {
      credentials: { verify_token: "" },
      settings: { graph_version: null },
    });
    expect(resp.status).toBe(422);
    expect(await resp.text()).toContain("credentials.verify_token");
    expect((await send(client, "PATCH", "/admin/connections/nope-1", {})).status).toBe(404);
  });

  it("send test message", async () => {
    const client = makeClient();
    const http = new FetchMock();
    const route = http
      .post("http://evolution.test/message/sendText/coach")
      .respond(201, { key: { id: "T1" } });
    const ok = await send(client, "POST", "/admin/connections/evo-main/test", {
      to: "+55 41 99999-0000",
    });
    expect(await ok.json()).toEqual({ ok: true, message_id: "T1" });
    expect(route.called).toBe(true);
    route.respond(400, { message: "not on whatsapp" });
    const failed = (await (
      await send(client, "POST", "/admin/connections/evo-main/test", { to: "5541999990000" })
    ).json()) as { ok: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("400");
    expect(failed.error).toContain("not on whatsapp");
    expect(failed.error).not.toContain("evo-key");
    const unauth = await send(
      client,
      "POST",
      "/admin/connections/nope/test",
      { to: "5541999990000" },
      {
        "x-api-key": "",
      },
    );
    expect([401, 404]).toContain(unauth.status);
  });
});
