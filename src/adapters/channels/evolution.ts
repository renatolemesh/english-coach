/**
 * Evolution API v2 (unofficial, Baileys). Facts checked against the v2.3.7 source.
 *
 * credentials: api_key (instance token, header `apikey`)
 * settings:    base_url, instance
 * webhook:     configure the instance webhook with a static header
 *              {"x-webhook-secret": <connection webhook_secret>} and events [MESSAGES_UPSERT].
 *              Evolution does not sign payloads; the header is the authentication.
 */
import type { Choice } from "../../domain/choices.js";
import {
  type ConnectionConfig,
  connectionSecret,
  connectionSetting,
} from "../../domain/connections.js";
import { IncomingMessage, type MessageType } from "../../domain/messages.js";
import { getLogger } from "../../logging.js";
import type { Headers, WhatsAppChannel } from "../../ports/channel.js";
import {
  asObject,
  ChannelError,
  digits,
  HttpClient,
  MediaTooLargeError,
  parseEpoch,
  parseSize,
  safeEqual,
} from "./base.js";

const log = getLogger("coach.adapters.channels.evolution");

export const SECRET_HEADER = "x-webhook-secret";
const PHONE_SUFFIX = "@s.whatsapp.net";
const IGNORED_SUFFIXES = ["@g.us", "@broadcast", "@newsletter"];
const TYPES: Record<string, MessageType> = {
  conversation: "text", // Evolution rewrites extendedTextMessage to conversation
  extendedTextMessage: "text",
  audioMessage: "audio",
  imageMessage: "image",
};
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 1:1 chats: remoteJid (Evolution swaps @lid for remoteJidAlt when it can). */
function phoneOf(key: Record<string, unknown>): string | null {
  for (const name of ["remoteJidAlt", "remoteJid"]) {
    const jid = String(key[name] || "");
    if (jid.endsWith(PHONE_SUFFIX)) return digits(jid.split("@")[0] ?? "");
  }
  return null;
}

export class EvolutionChannel implements WhatsAppChannel {
  readonly provider = "evolution";
  readonly interactive = false;
  readonly http: HttpClient;
  private readonly instance: string;

  constructor(
    private readonly conn: ConnectionConfig,
    private readonly maxMedia: number,
  ) {
    this.instance = String(connectionSetting(conn, "instance"));
    this.http = new HttpClient(String(connectionSetting(conn, "base_url")).replace(/\/+$/, ""), {
      apikey: connectionSecret(conn, "api_key"),
    });
  }

  // --- inbound ---------------------------------------------------------------------------------

  verifyWebhook(headers: Headers, _body?: Buffer, _query?: Record<string, string>): boolean {
    const expected = this.conn.webhook_secret.value;
    return Boolean(expected) && safeEqual(headers[SECRET_HEADER] ?? "", expected);
  }

  parseWebhook(_headers: Headers, body: Buffer): IncomingMessage[] {
    const payload = asObject(JSON.parse(body.toString("utf8")));
    if (!payload) throw new TypeError("payload is not an object");
    if (payload.event !== "messages.upsert" || payload.instance !== this.instance) {
      return []; // send.message, status updates, other instances...
    }
    const items = payload.data;
    const messages: IncomingMessage[] = [];
    for (const data of Array.isArray(items) ? items : [items]) {
      try {
        const msg = EvolutionChannel.message(asObject(data) ?? {});
        if (msg) messages.push(msg);
      } catch (exc) {
        // one bad item must not drop the rest
        log.warning("evolution_message_unparseable", { error: String(exc) });
      }
    }
    return messages;
  }

  private static message(data: Record<string, unknown>): IncomingMessage | null {
    const key = asObject(data.key) ?? {};
    const jid = String(key.remoteJid || "");
    if (key.fromMe || IGNORED_SUFFIXES.some((s) => jid.endsWith(s))) {
      return null; // own messages, groups, status and channels are ignored
    }
    const phone = phoneOf(key);
    if (!phone || !key.id) return null;
    const message = asObject(data.message) ?? {};
    const messageType = String(data.messageType ?? "");
    const kind: MessageType = Object.hasOwn(TYPES, messageType)
      ? (TYPES[messageType] ?? "other")
      : "other";
    const text = message.conversation || asObject(message.extendedTextMessage)?.text;
    const { message: _dropped, ...clean } = data; // never keep media base64
    const isMedia = kind === "audio" || kind === "image";
    const media = isMedia ? asObject(message[messageType]) : null;
    return IncomingMessage.parse({
      id: key.id,
      from: phone,
      timestamp: parseEpoch(data.messageTimestamp),
      type: kind,
      text: kind === "text" ? (text ?? null) : null,
      media_ref: isMedia ? key.id : null,
      media_size: parseSize(media?.fileLength),
      raw: clean,
    });
  }

  async downloadMedia(mediaRef: string): Promise<[Buffer, string]> {
    // Base64 is ~4/3 of the bytes; stop reading as soon as the JSON grows past the limit.
    // Fetching by key.id needs Evolution's message persistence (DATABASE_SAVE_DATA_NEW_MESSAGE).
    const data =
      asObject(
        await this.http.postJsonBounded(
          `/chat/getBase64FromMediaMessage/${this.instance}`,
          { message: { key: { id: mediaRef } }, convertToMp4: false },
          Math.floor((this.maxMedia * 4) / 3) + 4096,
        ),
      ) ?? {};
    const encoded = String(data.base64 || "");
    if (Math.floor((encoded.length * 3) / 4) > this.maxMedia) {
      throw new MediaTooLargeError(`media ${mediaRef} exceeds ${this.maxMedia} bytes`);
    }
    if (encoded.length % 4 !== 0 || !BASE64_RE.test(encoded)) {
      throw new ChannelError(`invalid base64 for media ${mediaRef}`);
    }
    return [Buffer.from(encoded, "base64"), String(data.mimetype || "")];
  }

  // --- outbound --------------------------------------------------------------------------------

  private async post(endpoint: string, body: Record<string, unknown>): Promise<string> {
    const response = await this.http.request("POST", `/message/${endpoint}/${this.instance}`, {
      json: body,
    });
    return String(((await response.json()) as { key: { id: unknown } }).key.id);
  }

  sendText(to: string, text: string): Promise<string> {
    return this.post("sendText", { number: digits(to), text });
  }

  sendImage(to: string, png: Buffer, caption: string | null = null): Promise<string> {
    return this.post("sendMedia", {
      number: digits(to),
      mediatype: "image",
      mimetype: "image/png",
      fileName: "evaluation.png",
      caption: caption || "",
      media: png.toString("base64"), // raw base64, no data: prefix
    });
  }

  sendVoice(to: string, ogg: Buffer): Promise<string> {
    // encoding=false: our OGG/Opus is final; Evolution would otherwise re-encode at 128k.
    return this.post("sendWhatsAppAudio", {
      number: digits(to),
      audio: ogg.toString("base64"),
      encoding: false,
    });
  }

  sendChoice(to: string, choice: Choice): Promise<string> {
    // Evolution's sendButtons/sendList depend on the Baileys version and often do not render.
    return this.sendText(to, choice.fallbackText);
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
