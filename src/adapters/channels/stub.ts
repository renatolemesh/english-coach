/** Base for providers whose adapter is not written yet: fails loudly, never silently. */
import type { ConnectionConfig } from "../../domain/connections.js";
import type { IncomingMessage } from "../../domain/messages.js";
import type { WhatsAppChannel } from "../../ports/channel.js";

export class NotImplementedChannelError extends Error {
  override name = "NotImplementedError";
}

export abstract class NotImplementedChannel implements WhatsAppChannel {
  abstract readonly provider: string;
  readonly interactive = false;

  constructor(readonly conn: ConnectionConfig) {}

  private fail(): NotImplementedChannelError {
    return new NotImplementedChannelError(`provider '${this.provider}' is not implemented yet`);
  }

  verifyWebhook(): boolean | string {
    throw this.fail();
  }
  parseWebhook(): IncomingMessage[] {
    throw this.fail();
  }
  async downloadMedia(): Promise<[Buffer, string]> {
    throw this.fail();
  }
  async sendText(): Promise<string> {
    throw this.fail();
  }
  async sendImage(): Promise<string> {
    throw this.fail();
  }
  async sendVoice(): Promise<string> {
    throw this.fail();
  }
  async sendChoice(): Promise<string> {
    throw this.fail();
  }
  async close(): Promise<void> {}
}
