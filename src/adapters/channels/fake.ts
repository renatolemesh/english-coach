/** In-memory ChatChannel: records what would be sent (tests, simulate). */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Choice } from "../../domain/choices.js";
import type { Evaluation } from "../../domain/evaluation.js";
import type { IncomingMessage } from "../../domain/messages.js";
import type { ChatChannel } from "../../ports/channel.js";

export interface Sent {
  kind: "text" | "image" | "voice" | "choice" | "evaluation";
  to: string;
  text: string | null;
  data: Buffer | null;
}

export class FakeChannel implements ChatChannel {
  readonly provider = "fake";
  interactive = true;
  cards = true; // false: records evaluations as data, like the app
  readonly media = new Map<string, [Buffer, string]>();
  readonly sent: Sent[] = [];

  constructor(private readonly outDir: string | null = null) {} // images/voices also on disk

  parseWebhook(): IncomingMessage[] {
    return [];
  }

  verifyWebhook(): boolean {
    return true;
  }

  async downloadMedia(mediaRef: string): Promise<[Buffer, string]> {
    const found = this.media.get(mediaRef);
    if (!found) throw new Error(`no media ${mediaRef}`);
    return found;
  }

  async sendText(to: string, text: string) {
    return this.record({ kind: "text", to, text, data: null });
  }

  async sendImage(to: string, png: Buffer, caption: string | null = null) {
    return this.record({ kind: "image", to, text: caption, data: png }, ".png");
  }

  async sendVoice(to: string, ogg: Buffer) {
    return this.record({ kind: "voice", to, text: null, data: ogg }, ".ogg");
  }

  async sendEvaluation(to: string, evaluation: Evaluation, caption: string) {
    const json = Buffer.from(JSON.stringify(evaluation));
    return this.record({ kind: "evaluation", to, text: caption, data: json }, ".json");
  }

  async sendChoice(to: string, choice: Choice) {
    if (!this.interactive) return this.sendText(to, choice.fallbackText);
    const ids = choice.options.map((o) => o.id).join(" ");
    return this.record({ kind: "choice", to, text: `${choice.body} [${ids}]`, data: null });
  }

  async close(): Promise<void> {}

  private record(item: Sent, suffix = ""): string {
    this.sent.push(item);
    const id = `fake-${this.sent.length}`;
    if (this.outDir && item.data) {
      mkdirSync(this.outDir, { recursive: true });
      writeFileSync(path.join(this.outDir, `${id}-${item.kind}${suffix}`), item.data);
    }
    return id;
  }
}
