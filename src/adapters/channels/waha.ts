/**
 * WAHA (WhatsApp HTTP API) - structure only, not implemented yet.
 *
 * To implement: same interface as EvolutionChannel. WAHA posts `{"event": "message", "session",
 * "payload": {"id", "from": "5511...@c.us", "fromMe", "body", "hasMedia", "media": {"url",
 * "mimetype"}}}`; send with POST /api/sendText, /api/sendImage and /api/sendVoice
 * (`{"session", "chatId", "file": {"mimetype": "audio/ogg; codecs=opus", "data": <base64>}}`).
 * Check the current WAHA docs and capture real payloads into test/fixtures/waha/ first.
 */
import { NotImplementedChannel } from "./stub.js";

export class WahaChannel extends NotImplementedChannel {
  readonly provider = "waha";
}
