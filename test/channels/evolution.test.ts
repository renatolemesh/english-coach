import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaTooLargeError } from "../../src/adapters/channels/base.js";
import { EvolutionChannel, SECRET_HEADER } from "../../src/adapters/channels/evolution.js";
import { voiceHelp } from "../../src/domain/choices.js";
import { EN as pt } from "../../src/domain/texts.js";
import { evoConn, FetchMock, fixture } from "./helpers.js";

const BASE = "http://evolution.test";

let evo: EvolutionChannel;
let http: FetchMock;
beforeEach(() => {
  evo = new EvolutionChannel(evoConn(), 1000);
  http = new FetchMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = async (req: Request) => JSON.parse(await req.text());

function withChanges(dataUpdate: Record<string, unknown>, keyUpdate = {}): Buffer {
  const payload = JSON.parse(fixture("evolution/audio.json").toString());
  Object.assign(payload.data, dataUpdate);
  Object.assign(payload.data.key, keyUpdate);
  return Buffer.from(JSON.stringify(payload));
}

describe("EvolutionChannel", () => {
  it("parse text and audio", () => {
    const [text] = evo.parseWebhook({}, fixture("evolution/text.json"));
    expect([text?.id, text?.from, text?.type]).toEqual([
      "3EB0C0B4BD55A44A956A23",
      "5541999990000",
      "text",
    ]);
    expect(text?.text).toBe("I goed to the beach yesterday");
    const [audio] = evo.parseWebhook({}, fixture("evolution/audio.json"));
    expect([audio?.type, audio?.media_ref]).toEqual(["audio", "3A09D988F34AA24A71A915"]);
    expect(audio?.raw).not.toHaveProperty("message"); // media base64 never stored/queued
  });

  it("lid sender uses phone jid", () => {
    const [msg] = evo.parseWebhook({}, fixture("evolution/lid.json"));
    expect(msg?.from).toBe("5541977770000");
  });

  it.each(["group.json", "from_me.json", "send_message.json"])("ignored events: %s", (name) => {
    expect(evo.parseWebhook({}, fixture(`evolution/${name}`))).toEqual([]);
  });

  it("other instance is ignored", () => {
    const other = new EvolutionChannel(
      evoConn({ settings: { base_url: BASE, instance: "x" } }),
      1000,
    );
    expect(other.parseWebhook({}, fixture("evolution/text.json"))).toEqual([]);
  });

  it("secret header", () => {
    const body = Buffer.from("{}");
    expect(evo.verifyWebhook({ [SECRET_HEADER]: "hook-secret" }, body, {})).toBe(true);
    expect(evo.verifyWebhook({ [SECRET_HEADER]: "wrong" }, body, {})).toBe(false);
    expect(evo.verifyWebhook({}, body, {})).toBe(false);
  });

  it("send voice raw base64 without reencoding", async () => {
    const route = http
      .post(`${BASE}/message/sendWhatsAppAudio/coach`)
      .respond(201, { key: { id: "BAE5OUT", fromMe: true } });
    expect(await evo.sendVoice("5541999990000", Buffer.from("OggS-bytes"))).toBe("BAE5OUT");
    const body = await json(route.last);
    expect(body.audio).toBe(Buffer.from("OggS-bytes").toString("base64"));
    expect(body.audio.startsWith("data:")).toBe(false);
    expect(body.encoding).toBe(false);
    expect(route.last.headers.get("apikey")).toBe("evo-key");
  });

  it("send image and text", async () => {
    const media = http.post(`${BASE}/message/sendMedia/coach`).respond(201, { key: { id: "I1" } });
    const text = http.post(`${BASE}/message/sendText/coach`).respond(201, { key: { id: "T1" } });
    expect(await evo.sendImage("5541", Buffer.from("\x89PNG", "latin1"), "Score: 80/100")).toBe(
      "I1",
    );
    const body = await json(media.last);
    expect([body.mediatype, body.mimetype, body.caption]).toEqual([
      "image",
      "image/png",
      "Score: 80/100",
    ]);
    expect(await evo.sendText("5541", "oi")).toBe("T1");
    expect(await json(text.last)).toEqual({ number: "5541", text: "oi" });
  });

  it("download media", async () => {
    const route = http.post(`${BASE}/chat/getBase64FromMediaMessage/coach`).respond(201, {
      base64: Buffer.from("OggS").toString("base64"),
      mimetype: "audio/ogg; codecs=opus",
    });
    const [data, mime] = await evo.downloadMedia("3A09");
    expect([data.toString(), mime]).toEqual(["OggS", "audio/ogg; codecs=opus"]);
    expect((await json(route.last)).message).toEqual({ key: { id: "3A09" } });
    route.respond(201, { base64: Buffer.alloc(5000, "x").toString("base64") });
    await expect(evo.downloadMedia("big")).rejects.toThrow(MediaTooLargeError);
  });

  it.each(["1758819660", { low: 1758819660, high: 0 }, null, "garbage"])(
    "timestamps never break parsing: %j",
    (ts) => {
      const [msg] = evo.parseWebhook({}, withChanges({ messageTimestamp: ts }));
      expect(msg?.timestamp.getUTCFullYear()).toBeGreaterThanOrEqual(2025);
    },
  );

  it("media size is announced", () => {
    const [msg] = evo.parseWebhook({}, fixture("evolution/audio.json"));
    expect(msg?.media_size).toBe(47336);
  });

  it("one bad item does not drop the batch", () => {
    const good = JSON.parse(fixture("evolution/text.json").toString()).data;
    const broken = { key: { remoteJid: "5541@s.whatsapp.net" }, messageType: 5 };
    const payload = { event: "messages.upsert", instance: "coach", data: [broken, good] };
    expect(evo.parseWebhook({}, Buffer.from(JSON.stringify(payload))).map((m) => m.id)).toEqual([
      good.key.id,
    ]);
  });

  it("choices fall back to text", async () => {
    const text = http.post(`${BASE}/message/sendText/coach`).respond(201, { key: { id: "T2" } });
    expect(await evo.sendChoice("5541", voiceHelp(pt))).toBe("T2");
    expect((await json(text.last)).text).toBe(voiceHelp(pt).fallbackText);
  });
});
