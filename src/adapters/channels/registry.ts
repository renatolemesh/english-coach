/** provider name -> adapter. The only place that maps a connection to a channel class. */
import type { Settings } from "../../config.js";
import type { ConnectionConfig, Provider } from "../../domain/connections.js";
import type { WhatsAppChannel } from "../../ports/channel.js";
import { EvolutionChannel } from "./evolution.js";
import { MetaCloudChannel } from "./meta-cloud.js";
import { WahaChannel } from "./waha.js";
import { ZapiChannel } from "./zapi.js";

// provider: [credentials, settings]
export const REQUIRED: Record<Provider, readonly [readonly string[], readonly string[]]> = {
  meta: [["access_token", "app_secret", "verify_token"], ["phone_number_id"]],
  evolution: [["api_key"], ["base_url", "instance"]],
  waha: [[], []],
  zapi: [[], []],
};

export function missingFields(conn: ConnectionConfig): string[] {
  const [creds, settings] = REQUIRED[conn.provider];
  const missing = creds.filter((c) => !conn.credentials[c]).map((c) => `credentials.${c}`);
  for (const s of settings) {
    const value = conn.settings[s];
    if (value === undefined || value === null || value === "") missing.push(`settings.${s}`);
  }
  if (conn.provider === "evolution" && !conn.webhook_secret.value) missing.push("webhook_secret");
  return missing;
}

/** Throws (message starts with "connection <id>: missing") when a required field is absent. */
export class MisconfiguredConnectionError extends Error {
  override name = "ValueError";
}

export function buildChannel(conn: ConnectionConfig, settings: Settings): WhatsAppChannel {
  const missing = missingFields(conn);
  if (missing.length) {
    throw new MisconfiguredConnectionError(`connection ${conn.id}: missing ${missing.join(", ")}`);
  }
  switch (conn.provider) {
    case "meta":
      return new MetaCloudChannel(conn, settings.metaGraphVersion, settings.maxAudioBytes);
    case "evolution":
      return new EvolutionChannel(conn, settings.maxAudioBytes);
    case "waha":
      return new WahaChannel(conn);
    case "zapi":
      return new ZapiChannel(conn);
  }
}
