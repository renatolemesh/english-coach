/** Webhook endpoint (validate -> record -> enqueue -> 200), all in-process. */
import { describe, expect, it } from "vitest";
import { SECRET_HEADER } from "../../src/adapters/channels/evolution.js";
import { ConnectionConfig } from "../../src/domain/connections.js";
import type { ProcessMessageJob } from "../../src/worker/queue.js";
import { fixture, metaSignature } from "../channels/helpers.js";
import { type Client, makeClient } from "./helpers.js";

function postEvo(client: Client, name: string, secret = "hook-secret"): Promise<Response> {
  return client.request("/webhooks/evo-main", {
    method: "POST",
    body: new Uint8Array(fixture(name)),
    headers: { [SECRET_HEADER]: secret },
  });
}

const post = (client: Client, path: string, body: string | Buffer, headers = {}) =>
  client.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : new Uint8Array(body),
    headers,
  });

describe("webhooks", () => {
  it("evolution message is recorded and queued", async () => {
    const client = makeClient();
    const resp = await postEvo(client, "evolution/text.json");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ received: 1, queued: 1 });
    expect(client.queue.jobs).toHaveLength(1);
    const job = client.queue.jobs[0]?.data as ProcessMessageJob;
    expect(client.queue.jobs[0]?.name).toBe("process_message");
    expect(job.connection_id).toBe("evo-main");
    expect(job.event_id).toBe(1);
    expect(job.message.from).toBe("5541999990000");
    expect(job.message).not.toHaveProperty("raw");
    expect(client.events.recorded).toEqual([["evo-main", "3EB0C0B4BD55A44A956A23"]]);
  });

  it("redelivered webhook is processed once", async () => {
    const client = makeClient();
    const first = await postEvo(client, "evolution/audio.json");
    const again = await postEvo(client, "evolution/audio.json");
    expect(((await first.json()) as { queued: number }).queued).toBe(1);
    expect(await again.json()).toEqual({ received: 1, queued: 0 });
    expect(client.queue.jobs).toHaveLength(1);
  });

  it("auth errors", async () => {
    const client = makeClient();
    expect((await postEvo(client, "evolution/text.json", "nope")).status).toBe(401);
    expect((await post(client, "/webhooks/nope", "{}")).status).toBe(404);
    const body = fixture("meta/text.json");
    const bad = await post(client, "/webhooks/meta-main", body, {
      "x-hub-signature-256": metaSignature(body, "x"),
    });
    const good = await post(client, "/webhooks/meta-main", body, {
      "x-hub-signature-256": metaSignature(body),
    });
    expect(bad.status).toBe(401);
    expect(((await good.json()) as { queued: number }).queued).toBe(1);
    expect(client.queue.jobs).toHaveLength(1);
  });

  it("ignored events return 200 without queueing", async () => {
    const client = makeClient();
    for (const name of ["group.json", "from_me.json", "send_message.json"]) {
      const resp = await postEvo(client, `evolution/${name}`);
      expect(await resp.json()).toEqual({ received: 0, queued: 0 });
    }
    expect(client.queue.jobs).toEqual([]);
  });

  it("meta subscription handshake", async () => {
    const client = makeClient();
    const params = {
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "42",
    };
    const ok = await client.request(`/webhooks/meta-main?${new URLSearchParams(params)}`);
    const bad = await client.request(
      `/webhooks/meta-main?${new URLSearchParams({ ...params, "hub.verify_token": "x" })}`,
    );
    expect([ok.status, await ok.text()]).toEqual([200, "42"]);
    expect(bad.status).toBe(403);
  });

  it("oversized and malformed bodies", async () => {
    const client = makeClient();
    const big = Buffer.alloc(client.state.settings.webhookMaxBodyBytes + 1, "x");
    expect((await post(client, "/webhooks/evo-main", big)).status).toBe(413);
    const declared = await post(client, "/webhooks/evo-main", "{}", {
      "content-length": String(client.state.settings.webhookMaxBodyBytes + 1),
    });
    expect(declared.status).toBe(413);
    const bad = await post(client, "/webhooks/evo-main", "not json", {
      [SECRET_HEADER]: "hook-secret",
    });
    expect(bad.status).toBe(400);
  });

  it("unknown or invalid ids do not touch the store", async () => {
    const client = makeClient();
    const before = client.store.gets;
    expect((await post(client, "/webhooks/../../etc", "{}")).status).toBe(404);
    expect((await post(client, "/webhooks/a", "{}")).status).toBe(404);
    expect(client.store.gets).toBe(before);
    await post(client, "/webhooks/nope-1", "{}");
    await post(client, "/webhooks/nope-1", "{}");
    expect(client.store.gets).toBe(before + 1); // misses are cached too
  });

  it("chunked oversized body is rejected", async () => {
    const client = makeClient();
    const n = Math.floor(client.state.settings.webhookMaxBodyBytes / 65536) + 2;
    let sent = 0;
    const chunks = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < n) controller.enqueue(new Uint8Array(65536).fill(120));
        else controller.close();
      },
    });
    const resp = await client.request("/webhooks/evo-main", {
      method: "POST",
      body: chunks,
      headers: { [SECRET_HEADER]: "hook-secret" },
      duplex: "half",
    } as RequestInit);
    expect(resp.status).toBe(413);
  });

  it("non ascii secret is 401 not 500", async () => {
    const client = makeClient();
    const resp = await post(client, "/webhooks/evo-main", fixture("evolution/text.json"), {
      [SECRET_HEADER]: "sécret", // the byte 0xE9 on the wire
    });
    expect(resp.status).toBe(401);
  });

  it("enqueue failure releases the claim", async () => {
    const client = makeClient();
    client.queue.failWith = new Error("redis down");
    expect((await postEvo(client, "evolution/text.json")).status).toBe(503);
    expect(client.events.marks).toEqual([[1, "failed", "enqueue failed"]]);
    client.queue.failWith = null;
    const retry = await postEvo(client, "evolution/text.json");
    expect(((await retry.json()) as { queued: number }).queued).toBe(1); // retry accepted
  });

  it("stub provider webhook is 501", async () => {
    const waha = ConnectionConfig.parse({ id: "waha-1", name: "w", provider: "waha" });
    const client = makeClient([waha]);
    expect((await post(client, "/webhooks/waha-1", "{}")).status).toBe(501);
    expect((await client.request("/webhooks/waha-1")).status).toBe(501);
  });
});
