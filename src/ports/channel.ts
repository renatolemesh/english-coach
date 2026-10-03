/** A chat front end: WhatsApp (Meta Cloud API, Evolution), Telegram, the app. The core (graph,
 * lessons, reminders) only talks to this port; each adapter turns its calls into what the
 * channel has (buttons, lists, inline keyboards, app events). */
import type { Choice } from "../domain/choices.js";
import type { Evaluation } from "../domain/evaluation.js";
import type { IncomingMessage } from "../domain/messages.js";

export type Headers = Record<string, string>; // lower-case names

export interface ChatChannel {
  readonly provider: string;
  /** false: sendChoice sends choice.fallbackText (so use it sparingly) */
  readonly interactive: boolean;
  /** true: the evaluation goes out as the PNG card (render_image); false: sendEvaluation gets the
   * evaluation itself and draws it (the app), so no browser renders anything for it. */
  readonly cards: boolean;
  /** true: addresses are phone numbers (WhatsApp), checked against the phone typed at signup;
   * false (Telegram, app): the signup code alone proves who it is. */
  readonly phones: boolean;
  parseWebhook(headers: Headers, body: Buffer): IncomingMessage[];
  /** true/false for signature checks; a string for GET challenges to echo back. */
  verifyWebhook(headers: Headers, body: Buffer, query: Record<string, string>): boolean | string;
  downloadMedia(mediaRef: string): Promise<[Buffer, string]>;
  sendText(to: string, text: string): Promise<string>;
  sendImage(to: string, png: Buffer, caption?: string | null): Promise<string>;
  sendVoice(to: string, ogg: Buffer): Promise<string>;
  /** Channels without cards: the evaluation as data (caption: the score line and notes). */
  sendEvaluation?(to: string, evaluation: Evaluation, caption: string): Promise<string>;
  /** Buttons or a list. A tap comes back as the text command of the option id
   * (domain/choices commandForOption); providers without them send the fallback text. */
  sendChoice(to: string, choice: Choice): Promise<string>;
  close(): Promise<void>;
}
