import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelError, HttpStatusError } from "../../src/adapters/channels/base.js";
import { TelegramChannel, toHtml } from "../../src/adapters/channels/telegram.js";
import { levelMenu, option } from "../../src/domain/choices.js";
import { ConnectionConfig, type ConnectionInput } from "../../src/domain/connections.js";
import { EN } from "../../src/domain/texts.js";
import { FetchMock, fixture } from "./helpers.js";

const TOKEN = "123456:ABC-secret-token";
const API = `https://api.telegram.org/bot${TOKEN}`;

function telegramConn(overrides: Partial<ConnectionInput> = {}): ConnectionConfig {
  return ConnectionConfig.parse({
    id: "telegram-main",
    name: "Telegram",
    provider: "telegram",
    credentials: { bot_token: TOKEN },
    webhook_secret: "hook-secret",
    ...overrides,
  });
}

let tg: TelegramChannel;
let http: FetchMock;
beforeEach(() => {
  tg = new TelegramChannel(telegramConn(), 20_000);
  tg.http.wait = 0;
  http = new FetchMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = async (req: Request) => JSON.parse(await req.text());

describe("TelegramChannel", () => {
  it("parses text and voice from private chats; the chat id is the address", () => {
    const [text] = tg.parseWebhook({}, fixture("telegram/text.json"));
    expect([text?.id, text?.type, text?.from, text?.text]).toEqual([
      "tg-900001",
      "text",
      "7001",
      "I goed to the beach yesterday",
    ]);
    const [voice] = tg.parseWebhook({}, fixture("telegram/voice.json"));
    expect([voice?.type, voice?.media_ref, voice?.media_size]).toEqual([
      "audio",
      "AwACAgEAAxkBAAMMZ",
      14563,
    ]);
    expect(tg.parseWebhook({}, fixture("telegram/group.json"))).toEqual([]); // groups: ignored
  });

  it("a deep link code becomes the signup code; a bare /start opens the menu", () => {
    const [start] = tg.parseWebhook({}, fixture("telegram/start_code.json"));
    expect(start?.text).toBe("ATIVAR 482913");
    expect(TelegramChannel.text("/start")).toBe("/menu");
    expect(TelegramChannel.text("/start@saybest_bot VINCULAR_000123")).toBe("VINCULAR 000123");
    expect(TelegramChannel.text("/aula")).toBe("/aula");
  });

  it("a button tap is answered and comes back as the option's command", async () => {
    const answer = http.post(`${API}/answerCallbackQuery`).respond(200, { ok: true });
    const [tap] = tg.parseWebhook({}, fixture("telegram/callback.json"));
    expect([tap?.type, tap?.from, tap?.text]).toEqual(["text", "7001", "/tema 2"]);
    await vi.waitFor(() => expect(answer.called).toBe(true));
    expect((await json(answer.last)).callback_query_id).toBe("4382bfdwdsb323b2d9");
  });

  it("the webhook secret header is required", () => {
    const body = fixture("telegram/text.json");
    expect(tg.verifyWebhook({ "x-telegram-bot-api-secret-token": "hook-secret" })).toBe(true);
    expect(tg.verifyWebhook({ "x-telegram-bot-api-secret-token": "nope" })).toBe(false);
    expect(tg.verifyWebhook({})).toBe(false);
    const open = new TelegramChannel(telegramConn({ webhook_secret: "" }), 1000);
    expect(open.verifyWebhook({ "x-telegram-bot-api-secret-token": "" })).toBe(false);
    expect(body.length).toBeGreaterThan(0);
  });

  it("texts go as HTML; buttons as an inline keyboard, one per row", async () => {
    const send = http
      .post(`${API}/sendMessage`)
      .respond(200, { ok: true, result: { message_id: 42 } });
    expect(await tg.sendText("7001", "*Score* 82 < 90 & _good_ work ___ here")).toBe("42");
    const body = await json(send.last);
    expect(body.text).toBe("<b>Score</b> 82 &lt; 90 &amp; <i>good</i> work ___ here");
    expect(body.parse_mode).toBe("HTML");
    await tg.sendChoice("7001", levelMenu(EN, "B1", "fallback"));
    const keyboard = (await json(send.last)).reply_markup.inline_keyboard;
    expect(keyboard.length).toBe(7); // six levels + the placement test
    expect(keyboard[0][0].callback_data).toBe("nivel:A1");
    expect([...keyboard[0][0].text].length).toBeLessThanOrEqual(48);
    await tg.sendChoice("7001", {
      body: "Pick",
      options: [option("ex:abc1", "on"), option("ex:abc2", "for")],
      button: "",
      fallbackText: "",
    });
    expect((await json(send.last)).reply_markup.inline_keyboard).toEqual([
      [{ text: "on", callback_data: "ex:abc1" }],
      [{ text: "for", callback_data: "ex:abc2" }],
    ]);
  });

  it("voice and photo are uploaded as files", async () => {
    const voice = http
      .post(`${API}/sendVoice`)
      .respond(200, { ok: true, result: { message_id: 7 } });
    const photo = http
      .post(`${API}/sendPhoto`)
      .respond(200, { ok: true, result: { message_id: 8 } });
    expect(await tg.sendVoice("7001", Buffer.from("OggS..."))).toBe("7");
    const form = await voice.last.text();
    expect(form).toContain('filename="reply.ogg"');
    expect(form).toContain("7001");
    expect(await tg.sendImage("7001", Buffer.from("\x89PNG", "latin1"), "Score: 70/100")).toBe("8");
    expect(await photo.last.text()).toContain("Score: 70/100");
  });

  it("downloads a voice note in two steps, bounded, and never leaks the token", async () => {
    const getFile = http.post(`${API}/getFile`).respond(200, {
      ok: true,
      result: { file_id: "F1", file_size: 4, file_path: "voice/file_1.oga" },
    });
    http
      .get(`https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`)
      .respond(200, Buffer.from("OggS"));
    const [data, mime] = await tg.downloadMedia("F1");
    expect([data.toString(), mime]).toEqual(["OggS", "audio/ogg"]);
    getFile.respond(200, { ok: true, result: { file_size: 999_999 } });
    await expect(tg.downloadMedia("BIG")).rejects.toThrow(ChannelError);
    http
      .post(`${API}/sendMessage`)
      .respond(403, { ok: false, description: `bot ${TOKEN} blocked` });
    const failure = await tg.sendText("7001", "hi").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HttpStatusError);
    expect(String((failure as Error).message)).not.toContain(TOKEN);
    expect((failure as HttpStatusError).body).not.toContain(TOKEN);
  });

  it("WhatsApp formatting to HTML", () => {
    expect(toHtml("*I ___ agree*")).toBe("<b>I ___ agree</b>");
    expect(toHtml("Tradução: _Espero que não._")).toBe("Tradução: <i>Espero que não.</i>");
    expect(toHtml("snake_case_word")).toBe("snake_case_word");
  });
});
