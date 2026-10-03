/**
 * Official WhatsApp Cloud API (Meta Graph API).
 *
 * credentials: access_token, app_secret, verify_token
 * settings:    phone_number_id, graph_version (optional, default from META_GRAPH_VERSION)
 */
import { createHmac } from "node:crypto";
import {
  BUTTON_TITLE_CHARS,
  type Choice,
  commandForOption,
  isList,
  MAX_BUTTONS,
  MAX_ROWS,
  ROW_DESCRIPTION_CHARS,
  ROW_TITLE_CHARS,
} from "../../domain/choices.js";
import {
  type ConnectionConfig,
  connectionSecret,
  connectionSetting,
} from "../../domain/connections.js";
import { IncomingMessage, type MessageType } from "../../domain/messages.js";
import { getLogger } from "../../logging.js";
import type { ChatChannel, Headers } from "../../ports/channel.js";
import { asObject, ChannelError, digits, HttpClient, parseEpoch, safeEqual } from "./base.js";

const log = getLogger("coach.adapters.channels.meta_cloud");

export const GRAPH = "https://graph.facebook.com";
// Voice notes must be uploaded with EXACTLY this MIME ("audio/opus" -> error 131053).
export const VOICE_MIME = "audio/ogg; codecs=opus";
const MEDIA_HOSTS = [".fbsbx.com", ".facebook.com", ".whatsapp.net", ".fbcdn.net"];
const TYPES: Record<string, MessageType> = { text: "text", audio: "audio", image: "image" };

// Slices by code point, not UTF-16 unit (an emoji is never cut in half).
const clip = (text: string, n: number) => Array.from(text).slice(0, n).join("");

const field = (obj: Record<string, unknown> | null, key: string) => asObject(obj?.[key]) ?? {};

export class MetaCloudChannel implements ChatChannel {
  readonly provider = "meta";
  readonly interactive = true;
  readonly cards = true;
  readonly http: HttpClient;
  private readonly phoneId: string;
  readonly version: string;

  constructor(
    private readonly conn: ConnectionConfig,
    graphVersion: string,
    private readonly maxMedia: number,
  ) {
    this.phoneId = String(connectionSetting(conn, "phone_number_id"));
    this.version = (conn.settings.graph_version as string | undefined) || graphVersion;
    this.http = new HttpClient(`${GRAPH}/${this.version}`, {
      Authorization: `Bearer ${connectionSecret(conn, "access_token")}`,
    });
  }

  // --- inbound ---------------------------------------------------------------------------------

  verifyWebhook(headers: Headers, body: Buffer, query: Record<string, string>): boolean | string {
    if (query["hub.mode"] === "subscribe") {
      // GET subscription handshake
      const ok = safeEqual(
        query["hub.verify_token"] ?? "",
        connectionSecret(this.conn, "verify_token"),
      );
      return ok ? (query["hub.challenge"] ?? "") : false;
    }
    const signature = headers["x-hub-signature-256"] ?? "";
    const expected = `sha256=${createHmac("sha256", connectionSecret(this.conn, "app_secret"))
      .update(body)
      .digest("hex")}`;
    return safeEqual(signature, expected);
  }

  parseWebhook(_headers: Headers, body: Buffer): IncomingMessage[] {
    const payload = asObject(JSON.parse(body.toString("utf8")));
    if (!payload) throw new TypeError("payload is not an object");
    const messages: IncomingMessage[] = [];
    for (const entry of (payload.entry as unknown[]) ?? []) {
      for (const change of (asObject(entry)?.changes as unknown[]) ?? []) {
        const ch = asObject(change);
        const value = field(ch, "value");
        if (ch?.field !== "messages") continue;
        if (String(field(value, "metadata").phone_number_id) !== this.phoneId) continue; // another number on the same app
        for (const raw of (value.messages as unknown[]) ?? []) {
          // `statuses` are ignored
          try {
            messages.push(MetaCloudChannel.message(asObject(raw) ?? {}));
          } catch (exc) {
            log.warning("meta_message_unparseable", { error: String(exc) });
          }
        }
      }
    }
    return messages;
  }

  private static message(raw: Record<string, unknown>): IncomingMessage {
    let kind: MessageType = TYPES[String(raw.type ?? "")] ?? "other";
    const mediaRef = kind === "audio" || kind === "image" ? field(raw, kind).id : null;
    let text = kind === "text" ? field(raw, "text").body : null;
    if (raw.type === "interactive") {
      // tap on one of our buttons or list rows
      const interactive = asObject(raw.interactive);
      const reply = interactive ? interactive.button_reply || interactive.list_reply : null;
      const optionId = asObject(reply)?.id;
      const command = commandForOption(optionId ? String(optionId) : "");
      if (command) {
        kind = "text";
        text = command;
      }
    }
    if (typeof raw.id !== "string" || typeof raw.from !== "string") {
      throw new TypeError("message without id/from");
    }
    return IncomingMessage.parse({
      id: raw.id,
      from: digits(raw.from),
      timestamp: parseEpoch(raw.timestamp),
      type: kind,
      text: text ?? null,
      media_ref: mediaRef ?? null,
      raw,
    });
  }

  async downloadMedia(mediaRef: string): Promise<[Buffer, string]> {
    const info = asObject(await (await this.http.request("GET", `/${mediaRef}`)).json()) ?? {};
    if (Number(info.file_size || 0) > this.maxMedia) {
      throw new ChannelError(`media ${mediaRef} is ${info.file_size} bytes`);
    }
    const url = new URL(String(info.url));
    if (url.protocol !== "https:" || !MEDIA_HOSTS.some((h) => url.hostname.endsWith(h))) {
      throw new ChannelError(`unexpected media host ${url.hostname}`); // never send the token there
    }
    const [data, contentType] = await this.http.download(String(info.url), this.maxMedia);
    return [data, (info.mime_type as string) || contentType];
  }

  // --- outbound --------------------------------------------------------------------------------

  private async send(to: string, kind: string, content: Record<string, unknown>): Promise<string> {
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits(to),
      type: kind,
      [kind]: content,
    };
    const response = await this.http.request("POST", `/${this.phoneId}/messages`, { json: body });
    const data = (await response.json()) as { messages: { id: unknown }[] };
    return String(data.messages[0]?.id);
  }

  private async upload(data: Buffer, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);
    const response = await this.http.request("POST", `/${this.phoneId}/media`, { form });
    return String(((await response.json()) as { id: unknown }).id);
  }

  sendText(to: string, text: string): Promise<string> {
    return this.send(to, "text", { body: text, preview_url: false });
  }

  async sendImage(to: string, png: Buffer, caption: string | null = null): Promise<string> {
    const mediaId = await this.upload(png, "image/png", "evaluation.png");
    return this.send(to, "image", { id: mediaId, ...(caption ? { caption } : {}) });
  }

  async sendVoice(to: string, ogg: Buffer): Promise<string> {
    const mediaId = await this.upload(ogg, VOICE_MIME, "reply.ogg");
    // voice=true -> shown as a voice note (play button), not as an audio file
    return this.send(to, "audio", { id: mediaId, voice: true });
  }

  sendChoice(to: string, choice: Choice): Promise<string> {
    let action: Record<string, unknown>;
    let kind: string;
    if (isList(choice)) {
      const rows = choice.options.slice(0, MAX_ROWS).map((o) => ({
        id: o.id,
        title: clip(o.title, ROW_TITLE_CHARS),
        ...(o.description ? { description: clip(o.description, ROW_DESCRIPTION_CHARS) } : {}),
      }));
      action = { button: clip(choice.button, BUTTON_TITLE_CHARS), sections: [{ rows }] };
      kind = "list";
    } else {
      action = {
        buttons: choice.options.slice(0, MAX_BUTTONS).map((o) => ({
          type: "reply",
          reply: { id: o.id, title: clip(o.title, BUTTON_TITLE_CHARS) },
        })),
      };
      kind = "button";
    }
    return this.send(to, "interactive", { type: kind, body: { text: choice.body }, action });
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
