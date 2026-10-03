/**
 * The app as a channel: what the bot sends becomes app events (GET /app/v1/events), so the
 * conversation, lessons, placement test and menus work in the app without code of their own.
 * The address is the student id. The evaluation goes as data (the app draws it: no PNG), the
 * tutor's voice as MP3 (iOS does not play OGG/Opus).
 */
import type { Choice } from "../../domain/choices.js";
import type { Evaluation } from "../../domain/evaluation.js";
import type { IncomingMessage } from "../../domain/messages.js";
import type { AppStore } from "../../ports/app.js";
import type { ChatChannel } from "../../ports/channel.js";
import { ChannelError } from "./base.js";

export const APP_CONNECTION = "app"; // the connection id of app messages (no row in connections)

export interface Transcoder {
  toMp3(data: Buffer): Promise<Buffer>;
}

export class AppChannel implements ChatChannel {
  readonly provider = "app";
  readonly interactive = true;
  readonly cards = false;
  readonly phones = false;

  constructor(
    private readonly store: AppStore,
    private readonly audio: Transcoder | null = null, // null: the OGG as it is (tests)
  ) {}

  private student(to: string): number {
    const id = Number(to);
    if (!Number.isInteger(id) || id <= 0) throw new ChannelError(`bad app address ${to}`);
    return id;
  }

  parseWebhook(): IncomingMessage[] {
    return []; // the app posts to /app/v1/messages, not to a webhook
  }

  verifyWebhook(): boolean {
    return false;
  }

  async downloadMedia(mediaRef: string): Promise<[Buffer, string]> {
    const media = await this.store.media(mediaRef);
    if (!media) throw new ChannelError(`no app media ${mediaRef}`);
    return [media.data, media.mime];
  }

  private async event(
    to: string,
    kind: "text" | "voice" | "image" | "choice" | "evaluation",
    fields: { text?: string | null; data?: unknown; mediaId?: string | null },
  ) {
    const id = await this.store.addEvent(this.student(to), {
      kind,
      text: fields.text ?? null,
      data: fields.data ?? null,
      mediaId: fields.mediaId ?? null,
    });
    return String(id);
  }

  sendText(to: string, text: string): Promise<string> {
    return this.event(to, "text", { text });
  }

  async sendImage(to: string, png: Buffer, caption: string | null = null): Promise<string> {
    const mediaId = await this.store.putMedia(this.student(to), png, "image/png");
    return this.event(to, "image", { text: caption, mediaId });
  }

  async sendVoice(to: string, ogg: Buffer): Promise<string> {
    const [data, mime] = this.audio
      ? [await this.audio.toMp3(ogg), "audio/mpeg"]
      : [ogg, "audio/ogg"];
    const mediaId = await this.store.putMedia(this.student(to), data, mime);
    return this.event(to, "voice", { mediaId });
  }

  sendEvaluation(to: string, evaluation: Evaluation, caption: string): Promise<string> {
    return this.event(to, "evaluation", { text: caption, data: evaluation });
  }

  sendChoice(to: string, choice: Choice): Promise<string> {
    const options = choice.options.map(({ id, title, description }) => ({
      id,
      title,
      description,
    }));
    return this.event(to, "choice", {
      text: choice.body,
      data: { options, list: Boolean(choice.button) },
    });
  }

  async close(): Promise<void> {}
}
