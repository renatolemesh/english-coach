/**
 * Z-API - structure only, not implemented yet.
 *
 * To implement: webhooks "on-message-received" post `{"phone", "fromMe", "isGroup", "messageId",
 * "text": {"message"}, "audio": {"audioUrl", "mimeType"}}`; send with
 * POST /instances/{id}/token/{token}/send-text, /send-image and /send-audio (header Client-Token).
 * Check the current Z-API docs and capture real payloads into test/fixtures/zapi/ first.
 */
import { NotImplementedChannel } from "./stub.js";

export class ZapiChannel extends NotImplementedChannel {
  readonly provider = "zapi";
}
