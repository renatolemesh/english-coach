/** EventLog.claim is atomic on real Postgres: only one of N concurrent claims wins. Also the
 * ConnectionStore round trip (Fernet at rest) on the real table. */
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialCipher, Fernet } from "../../src/connections/crypto.js";
import { EventLog } from "../../src/connections/events.js";
import { ConnectionStore } from "../../src/connections/store.js";
import { connect } from "../../src/db/client.js";
import { channelConnections, webhookEvents } from "../../src/db/schema.js";
import { evoConn } from "../channels/helpers.js";
import { TEST_DATABASE_URL } from "./helpers.js";

const database = connect(TEST_DATABASE_URL, 8);
afterAll(async () => {
  await database.db.delete(webhookEvents).where(eq(webhookEvents.connectionId, "it-events"));
  await database.db.delete(channelConnections).where(eq(channelConnections.id, "it-evo"));
  await database.close();
});

describe("EventLog (Postgres)", () => {
  it("concurrent claims have one winner", async () => {
    const events = new EventLog(database.db);
    const eventId = await events.record("it-events", "m-1", { x: 1 });
    const results = await Promise.all(Array.from({ length: 5 }, () => events.claim(eventId)));
    expect(results.sort()).toEqual([false, false, false, false, true]);
    await events.mark(eventId, "queued"); // requeue makes it claimable again
    expect(await events.claim(eventId)).toBe(true);
    await events.mark(eventId, "failed", "x".repeat(3000));
    const [row] = await database.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId));
    expect([row?.status, row?.error?.length, row?.payload]).toEqual(["failed", 2000, { x: 1 }]);
  });
});

describe("ConnectionStore (Postgres)", () => {
  it("saves encrypted credentials and reads them back", async () => {
    const store = new ConnectionStore(database.db, new CredentialCipher(Fernet.generateKey()));
    await store.save(evoConn({ id: "it-evo" }));
    await store.save(evoConn({ id: "it-evo", name: "Renamed" })); // upsert
    const [row] = await database.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, "it-evo"));
    expect(row?.credentials).not.toContain("evo-key");
    expect(row?.webhookSecret).not.toContain("hook-secret");
    const conn = await store.get("it-evo");
    expect(conn?.name).toBe("Renamed");
    expect(conn?.credentials.api_key?.value).toBe("evo-key");
    expect(conn?.webhook_secret.value).toBe("hook-secret");
    expect(conn?.settings).toEqual({ base_url: "http://evolution.test", instance: "coach" });
    expect((await store.list()).some((c) => c.id === "it-evo")).toBe(true);
    expect(await store.setEnabled("it-evo", false)).toBe(true);
    expect((await store.get("it-evo"))?.enabled).toBe(false);
    expect(await store.get("it-missing")).toBeNull();
  });
});
