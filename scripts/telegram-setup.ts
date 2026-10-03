/**
 * Register a Telegram connection's webhook and the bot's command list.
 *
 *   npx tsx scripts/telegram-setup.ts [--connection telegram-main]
 *
 * The connection must exist (provider telegram, credentials.bot_token from @BotFather and a
 * webhook_secret; admin API or connections.yaml). Telegram will POST to
 * PUBLIC_BASE_URL/webhooks/<connection> with the secret in a header. Prints the bot's @username,
 * which goes in the panel's settings (telegram_bot); never prints the token.
 */
import { parseArgs } from "node:util";
import { TelegramChannel } from "../src/adapters/channels/telegram.js";
import { getSettings } from "../src/config.js";
import { CredentialCipher } from "../src/connections/crypto.js";
import { ConnectionStore } from "../src/connections/store.js";
import { connect } from "../src/db/client.js";

const COMMANDS: [string, string][] = [
  ["aula", "Aula rápida com exercícios"],
  ["revisar", "Revisar o que você aprendeu"],
  ["teste", "Teste de nível (2 minutos)"],
  ["tema", "Ver ou trocar o tema da conversa"],
  ["nivel", "Ver ou ajustar o nível"],
  ["voz", "Escolher a voz do tutor"],
  ["meta", "Sua meta diária e o caminho para o próximo nível"],
  ["lembretes", "Ligar ou desligar o lembrete da meta"],
  ["menu", "Todas as opções"],
  ["ajuda", "Como funciona"],
];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { connection: { type: "string", default: "telegram-main" } },
  });
  const id = values.connection;
  const settings = getSettings();
  const database = connect(settings.databaseUrl, 1);
  try {
    const store = new ConnectionStore(database.db, new CredentialCipher(settings.fernetKey.value));
    const conn = await store.get(id);
    if (conn?.provider !== "telegram") throw new Error(`no telegram connection '${id}'`);
    if (!conn.webhook_secret.value) throw new Error(`connection '${id}' has no webhook_secret`);
    const bot = new TelegramChannel(conn, settings.maxAudioBytes);
    const call = async (method: string, json: unknown) =>
      (await bot.http.request("POST", `/${method}`, { json })).json() as Promise<{
        result?: Record<string, unknown>;
      }>;
    const me = await call("getMe", {});
    const url = `${settings.publicBaseUrl.replace(/\/+$/, "")}/webhooks/${id}`;
    await call("setWebhook", {
      url,
      secret_token: conn.webhook_secret.value,
      allowed_updates: ["message", "callback_query"],
    });
    await call("setMyCommands", {
      commands: COMMANDS.map(([command, description]) => ({ command, description })),
    });
    console.log(`webhook: ${url}`);
    console.log(`bot: @${me.result?.username} (put it in the panel's settings: telegram_bot)`);
  } finally {
    await database.close();
  }
}

await main();
