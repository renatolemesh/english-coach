/**
 * Telegram Bot API. No per-message fee, voice notes, inline keyboards: the cheap channel.
 *
 * - Webhook: Telegram sends the secret given to setWebhook in X-Telegram-Bot-Api-Secret-Token
 *   (scripts/telegram-setup.ts registers it). Only private chats are handled.
 * - The address is the chat id; there is no phone (the signup code proves who it is).
 * - "/start ATIVAR_123456" (a t.me deep link) becomes "ATIVAR 123456", the same code the
 *   WhatsApp signup uses; a bare "/start" (Telegram sends it when a chat is opened) becomes
 *   "/menu", so it never restarts an ongoing conversation.
 * - A button tap (callback_query) is answered at once (it stops the spinner) and comes back as
 *   the command of the option id, like WhatsApp's reply buttons.
 * - Texts use WhatsApp's *bold* and _italic_: sent as HTML.
 */
import type { Choice } from "../../domain/choices.js";
import { commandForOption } from "../../domain/choices.js";
import type { ConnectionConfig } from "../../domain/connections.js";
import { connectionSecret } from "../../domain/connections.js";
import { IncomingMessage } from "../../domain/messages.js";
import { getLogger } from "../../logging.js";
import type { ChatChannel, Headers } from "../../ports/channel.js";
import { asObject, ChannelError, HttpClient, safeEqual } from "./base.js";

const log = getLogger("coach.adapters.channels.telegram");
const API = "https://api.telegram.org";
const BUTTON_CHARS = 48; // longer titles are cut (Telegram wraps or truncates them anyway)
const START_RE = /^\/start(?:@\w+)?(?:\s+([A-Za-z]+)_(\d{6}))?\s*$/;

/** WhatsApp formatting -> Telegram HTML: escape, then *bold*, _italic_, ~strike~. */
export function toHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,!?:;<])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(>])~([^~\n]+)~(?=$|[\s).,!?:;<])/g, "$1<s>$2</s>");
}

const clip = (s: string, n: number) =>
  [...s].length <= n ? s : `${[...s].slice(0, n - 1).join("")}…`;

export class TelegramChannel implements ChatChannel {
  readonly provider = "telegram";
  readonly interactive = true;
  readonly cards = true;
  readonly phones = false;
  readonly http: HttpClient;
  private readonly token: string;

  constructor(
    private readonly conn: ConnectionConfig,
    private readonly maxMedia: number,
  ) {
    this.token = connectionSecret(conn, "bot_token");
    this.http = new HttpClient(`${API}/bot${this.token}`, {}, 3, 1.0, [this.token]);
  }

  // --- inbound ---------------------------------------------------------------------------------

  verifyWebhook(headers: Headers): boolean {
    const secret = this.conn.webhook_secret.value;
    return Boolean(secret) && safeEqual(headers["x-telegram-bot-api-secret-token"] ?? "", secret);
  }

  parseWebhook(_headers: Headers, body: Buffer): IncomingMessage[] {
    const update = asObject(JSON.parse(body.toString("utf8")));
    if (!update) throw new TypeError("payload is not an object");
    const id = String(update.update_id ?? "");
    const callback = asObject(update.callback_query);
    if (callback) {
      void this.answerCallback(String(callback.id ?? "")); // stop the button's spinner
      const chat = asObject(asObject(callback.message)?.chat);
      if (chat?.type !== "private") return [];
      const data = String(callback.data ?? "");
      return [
        IncomingMessage.parse({
          id: `tg-${id}`,
          from: String(chat.id),
          timestamp: new Date(),
          type: "text",
          text: commandForOption(data) ?? data,
          raw: update,
        }),
      ];
    }
    const message = asObject(update.message);
    const chat = asObject(message?.chat);
    if (!message || chat?.type !== "private") return []; // groups, channels, edits
    const base = {
      id: `tg-${id}`,
      from: String(chat.id),
      timestamp: new Date(Number(message.date ?? 0) * 1000 || Date.now()),
      raw: update,
    };
    const voice = asObject(message.voice) ?? asObject(message.audio);
    if (voice) {
      return [
        IncomingMessage.parse({
          ...base,
          type: "audio",
          media_ref: String(voice.file_id),
          media_size: typeof voice.file_size === "number" ? voice.file_size : null,
        }),
      ];
    }
    if (typeof message.text === "string") {
      return [
        IncomingMessage.parse({ ...base, type: "text", text: TelegramChannel.text(message.text) }),
      ];
    }
    return [IncomingMessage.parse({ ...base, type: "other" })];
  }

  /** "/start ATIVAR_123456" -> "ATIVAR 123456"; a bare "/start" -> "/menu". */
  static text(text: string): string {
    const start = START_RE.exec(text.trim());
    if (!start) return text;
    return start[1] && start[2] ? `${start[1]} ${start[2]}` : "/menu";
  }

  private async answerCallback(callbackId: string): Promise<void> {
    if (!callbackId) return;
    try {
      await this.http.request("POST", "/answerCallbackQuery", {
        json: { callback_query_id: callbackId },
      });
    } catch (exc) {
      log.warning("callback_answer_failed", { error: String(exc) }); // only the spinner stays
    }
  }

  async downloadMedia(fileId: string): Promise<[Buffer, string]> {
    const response = await this.http.request("POST", "/getFile", { json: { file_id: fileId } });
    const file = asObject(asObject(await response.json())?.result) ?? {};
    if (Number(file.file_size || 0) > this.maxMedia) {
      throw new ChannelError(`file ${fileId} is ${file.file_size} bytes`);
    }
    const filePath = String(file.file_path ?? "");
    if (!/^[\w./-]+$/.test(filePath)) throw new ChannelError("unexpected file path");
    const [data] = await this.http.download(
      `${API}/file/bot${this.token}/${filePath}`,
      this.maxMedia,
    );
    return [data, "audio/ogg"]; // voice notes are OGG/Opus; ffmpeg reads the rest anyway
  }

  // --- outbound --------------------------------------------------------------------------------

  private async call(method: string, opts: { json?: unknown; form?: FormData }): Promise<string> {
    const response = await this.http.request("POST", `/${method}`, opts);
    const result = asObject(asObject(await response.json())?.result);
    return String(result?.message_id ?? "");
  }

  private upload(
    method: string,
    field: string,
    to: string,
    data: Buffer,
    name: string,
    mime: string,
    caption?: string | null,
  ) {
    const form = new FormData();
    form.append("chat_id", to);
    form.append(field, new Blob([new Uint8Array(data)], { type: mime }), name);
    if (caption) {
      form.append("caption", toHtml(caption));
      form.append("parse_mode", "HTML");
    }
    return this.call(method, { form });
  }

  sendText(to: string, text: string): Promise<string> {
    return this.call("sendMessage", {
      json: {
        chat_id: to,
        text: toHtml(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    });
  }

  sendImage(to: string, png: Buffer, caption: string | null = null): Promise<string> {
    return this.upload("sendPhoto", "photo", to, png, "evaluation.png", "image/png", caption);
  }

  sendVoice(to: string, ogg: Buffer): Promise<string> {
    return this.upload("sendVoice", "voice", to, ogg, "reply.ogg", "audio/ogg");
  }

  /** One button per row: titles stay readable on a phone (no 3-button or 20-char limit). */
  sendChoice(to: string, choice: Choice): Promise<string> {
    const rows = choice.options.map((o) => [
      {
        text: clip(o.description ? `${o.title} · ${o.description}` : o.title, BUTTON_CHARS),
        callback_data: o.id,
      },
    ]);
    return this.call("sendMessage", {
      json: {
        chat_id: to,
        text: toHtml(choice.body),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      },
    });
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
