/** A WhatsApp provider (Meta Cloud API, Evolution, ...). */
import type { Choice } from "../domain/choices.js";
import type { IncomingMessage } from "../domain/messages.js";

export type Headers = Record<string, string>; // lower-case names

export interface WhatsAppChannel {
  readonly provider: string;
  /** false: sendChoice sends choice.fallbackText (so use it sparingly) */
  readonly interactive: boolean;
  parseWebhook(headers: Headers, body: Buffer): IncomingMessage[];
  /** true/false for signature checks; a string for GET challenges to echo back. */
  verifyWebhook(headers: Headers, body: Buffer, query: Record<string, string>): boolean | string;
  downloadMedia(mediaRef: string): Promise<[Buffer, string]>;
  sendText(to: string, text: string): Promise<string>;
  sendImage(to: string, png: Buffer, caption?: string | null): Promise<string>;
  sendVoice(to: string, ogg: Buffer): Promise<string>;
  /** Buttons or a list. A tap comes back as the text command of the option id
   * (domain/choices commandForOption); providers without them send the fallback text. */
  sendChoice(to: string, choice: Choice): Promise<string>;
  close(): Promise<void>;
}
