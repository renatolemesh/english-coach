import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelError, HttpStatusError } from "../../src/adapters/channels/base.js";
import { MetaCloudChannel, VOICE_MIME } from "../../src/adapters/channels/meta-cloud.js";
import { levelMenu, option } from "../../src/domain/choices.js";
import { EN } from "../../src/domain/texts.js";
import { FetchMock, fixture, metaConn, metaSignature } from "./helpers.js";

const GRAPH = "https://graph.facebook.com/v26.0";

let meta: MetaCloudChannel;
let http: FetchMock;
beforeEach(() => {
  meta = new MetaCloudChannel(metaConn(), "v26.0", 1000);
  http = new FetchMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = async (req: Request) => JSON.parse(await req.text());

describe("MetaCloudChannel", () => {
  it("parse text and audio", () => {
    const [text] = meta.parseWebhook({}, fixture("meta/text.json"));
    expect([text?.type, text?.from, text?.text]).toEqual([
      "text",
      "5541999990000",
      "I goed to the beach yesterday",
    ]);
    const [audio] = meta.parseWebhook({}, fixture("meta/audio.json"));
    expect([audio?.type, audio?.media_ref, audio?.text]).toEqual([
      "audio",
      "1320481532487812",
      null,
    ]);
    expect(audio?.timestamp.getUTCFullYear()).toBe(2025);
  });

  it("statuses and other numbers are ignored", () => {
    expect(meta.parseWebhook({}, fixture("meta/status.json"))).toEqual([]);
    const other = new MetaCloudChannel(
      metaConn({ settings: { phone_number_id: "999" } }),
      "v26.0",
      1000,
    );
    expect(other.parseWebhook({}, fixture("meta/text.json"))).toEqual([]);
  });

  it("signature", () => {
    const body = fixture("meta/text.json");
    expect(meta.verifyWebhook({ "x-hub-signature-256": metaSignature(body) }, body, {})).toBe(true);
    expect(meta.verifyWebhook({ "x-hub-signature-256": metaSignature(body, "x") }, body, {})).toBe(
      false,
    );
    expect(meta.verifyWebhook({}, body, {})).toBe(false);
  });

  it("subscription challenge", () => {
    const query = {
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "1158201444",
    };
    expect(meta.verifyWebhook({}, Buffer.alloc(0), query)).toBe("1158201444");
    expect(meta.verifyWebhook({}, Buffer.alloc(0), { ...query, "hub.verify_token": "nope" })).toBe(
      false,
    );
  });

  it("send voice uploads ogg opus and sets voice true", async () => {
    const upload = http.post(`${GRAPH}/106540352242922/media`).respond(200, { id: "MEDIA1" });
    const send = http
      .post(`${GRAPH}/106540352242922/messages`)
      .respond(200, { messages: [{ id: "wamid.OUT" }] });
    expect(await meta.sendVoice("+55 41 99999-0000", Buffer.from("OggS..."))).toBe("wamid.OUT");
    const form = await upload.last.text();
    expect(form).toContain('filename="reply.ogg"');
    expect(form).toContain(VOICE_MIME);
    expect(form).toContain("messaging_product");
    const body = await json(send.last);
    expect(body.to).toBe("5541999990000");
    expect(body.type).toBe("audio");
    expect(body.audio).toEqual({ id: "MEDIA1", voice: true });
    expect(send.last.headers.get("authorization")).toBe("Bearer EAAG-token");
  });

  it("send image with caption and text", async () => {
    http.post(`${GRAPH}/106540352242922/media`).respond(200, { id: "IMG1" });
    const send = http
      .post(`${GRAPH}/106540352242922/messages`)
      .respond(200, { messages: [{ id: "wamid.X" }] });
    await meta.sendImage("5541", Buffer.from("\x89PNG", "latin1"), "Score: 70/100");
    expect((await json(send.last)).image).toEqual({ id: "IMG1", caption: "Score: 70/100" });
    await meta.sendText("5541", "oi");
    expect((await json(send.last)).text.body).toBe("oi");
  });

  it("download media two steps and bounded", async () => {
    http.get(`${GRAPH}/M1`).respond(200, {
      url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
      mime_type: "audio/ogg; codecs=opus",
      file_size: 4,
    });
    http
      .get("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")
      .respond(200, Buffer.from("OggS"));
    const [data, mime] = await meta.downloadMedia("M1");
    expect([data.toString(), mime]).toEqual(["OggS", "audio/ogg; codecs=opus"]);
    http.get(`${GRAPH}/BIG`).respond(200, { url: "https://x.test/big", file_size: 5000 });
    await expect(meta.downloadMedia("BIG")).rejects.toThrow(ChannelError);
  });

  it("transient errors are retried but 4xx are not", async () => {
    const route = http
      .post(`${GRAPH}/106540352242922/messages`)
      .sequence([503], [200, { messages: [{ id: "ok" }] }]);
    meta.http.wait = 0;
    expect(await meta.sendText("5541", "hi")).toBe("ok");
    route.sequence([400, { error: { code: 131053 } }]);
    await expect(meta.sendText("5541", "hi")).rejects.toThrow(HttpStatusError);
    expect(route.calls.length).toBe(3);
  });

  it("non message fields are ignored", () => {
    const payload = JSON.parse(fixture("meta/text.json").toString());
    payload.entry[0].changes[0].field = "account_update";
    expect(meta.parseWebhook({}, Buffer.from(JSON.stringify(payload)))).toEqual([]);
  });

  it("media url host is validated before sending the token", async () => {
    http.get(`${GRAPH}/EVIL`).respond(200, { url: "https://attacker.example/x", file_size: 3 });
    const evil = http.get("https://attacker.example/x").respond(200, Buffer.from("abc"));
    await expect(meta.downloadMedia("EVIL")).rejects.toThrow(/unexpected media host/);
    expect(evil.called).toBe(false);
  });

  it("non ascii verify token is rejected not crashing", () => {
    const query = { "hub.mode": "subscribe", "hub.verify_token": "vérify", "hub.challenge": "1" };
    expect(meta.verifyWebhook({}, Buffer.alloc(0), query)).toBe(false);
  });

  it("taps on buttons and list rows become commands", () => {
    const [msg] = meta.parseWebhook({}, fixture("meta/button_reply.json"));
    expect([msg?.type, msg?.text]).toEqual(["text", "/traduzir"]);
    const payload = JSON.parse(fixture("meta/button_reply.json").toString());
    const raw = payload.entry[0].changes[0].value.messages[0];

    const parsed = () => {
      const [m] = meta.parseWebhook({}, Buffer.from(JSON.stringify(payload)));
      return [m?.type, m?.text];
    };

    raw.interactive = { type: "list_reply", list_reply: { id: "tema:3", title: "x" } };
    expect(parsed()).toEqual(["text", "/tema 3"]);
    raw.interactive = { type: "list_reply", list_reply: { id: "nivel:B2" } };
    expect(parsed()).toEqual(["text", "/nivel B2"]);
    for (const odd of [
      "x",
      null,
      { button_reply: "x" },
      { button_reply: { id: "evil" } },
      { button_reply: { id: "tema:../x" } },
      { list_reply: { id: "tema:1 /reset" } },
    ]) {
      raw.interactive = odd;
      expect(parsed(), JSON.stringify(odd)).toEqual(["other", null]);
    }
  });

  it("send choice as reply buttons or list", async () => {
    const send = http
      .post(`${GRAPH}/106540352242922/messages`)
      .respond(200, { messages: [{ id: "wamid.B" }] });
    const buttons = {
      body: "Ajuda?",
      options: [option("a", "A".repeat(30)), option("b", "B")],
      fallbackText: "fallback",
      button: "",
    };
    expect(await meta.sendChoice("5541", buttons)).toBe("wamid.B");
    let body = await json(send.last);
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.body).toEqual({ text: "Ajuda?" });
    expect(body.interactive.action.buttons[0]).toEqual({
      type: "reply",
      reply: { id: "a", title: "A".repeat(20) },
    });

    await meta.sendChoice("5541", levelMenu(EN, "B1", "fallback"));
    body = (await json(send.last)).interactive;
    expect(body.type).toBe("list");
    expect(body.action.button).toBe("See levels");
    const rows: { id: string; title: string; description?: string }[] =
      body.action.sections[0].rows;
    expect(rows.map((r) => r.id)).toEqual([
      "nivel:A1",
      "nivel:A2",
      "nivel:B1",
      "nivel:B2",
      "nivel:C1",
      "nivel:C2",
    ]);
    expect(rows.every((r) => r.title.length <= 24 && (r.description ?? "").length <= 72)).toBe(
      true,
    );
  });
});
