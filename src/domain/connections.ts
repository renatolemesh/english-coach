/** A chat connection (WhatsApp, Telegram), n8n-style: provider + credentials + webhook secret +
 * settings. */
import { z } from "zod";
import { Secret } from "../config.js";

export const Provider = z.enum(["meta", "evolution", "waha", "zapi", "telegram"]);
export type Provider = z.infer<typeof Provider>;

const secret = z
  .union([z.instanceof(Secret), z.string()])
  .transform((v) => (v instanceof Secret ? v : new Secret(v)));

export const ConnectionConfig = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{3,64}$/)
    .describe("Used in /webhooks/{id}."),
  name: z.string().max(120),
  provider: Provider,
  enabled: z.boolean().default(true),
  credentials: z.record(z.string(), secret).default(() => ({})), // decrypted, never logged
  webhook_secret: secret.default(() => new Secret("")),
  settings: z.record(z.string(), z.unknown()).default(() => ({})),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;
export type ConnectionInput = z.input<typeof ConnectionConfig>;

export function connectionSecret(conn: ConnectionConfig, name: string): string {
  const value = conn.credentials[name]?.value;
  if (!value) throw new Error(`connection ${conn.id}: missing credential '${name}'`);
  return value;
}

export function connectionSetting(conn: ConnectionConfig, name: string): unknown {
  const value = conn.settings[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`connection ${conn.id}: missing setting '${name}'`);
  }
  return value;
}
