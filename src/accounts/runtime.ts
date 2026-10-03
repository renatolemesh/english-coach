/**
 * Settings the admin changes in the panel (table `app_settings`), read by the API and the
 * worker. Unknown keys in the table are ignored; missing keys use the defaults below. Values are
 * cached for CACHE_TTL_S in the shared cache, and the panel clears that cache on save.
 * This file holds the schema and defaults; RuntimeConfigStore (runtime-store.ts) reads and saves them.
 */

import { z } from "zod";

export const CACHE_KEY = "runtime_config";
export const CACHE_TTL_S = 30;

// Lax numbers: the panel form posts numbers as text ("12", " 0.5 "), accepted as numbers.
const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const lax = (v: unknown) => (typeof v === "string" && NUMERIC.test(v) ? Number(v) : v);

export const RuntimeConfigSchema = z.object({
  unknown_numbers: z
    .enum(["reject", "trial"])
    .default("reject")
    .describe(
      "Número que nunca se cadastrou: recusar (com link de cadastro) " +
        "ou criar uma conta grátis na hora.",
    ),
  signup_enabled: z.boolean().default(true).describe("Permite cadastro pelo site."),
  trial_plan: z
    .string()
    .default("Teste Ilimitado")
    .describe("Plano de quem se cadastra (nome do plano)."),
  whatsapp_number: z
    .string()
    .default("")
    .describe(
      "Número do saybest no WhatsApp, só dígitos (ex.: 5541999990000). " +
        "Usado no botão de ativação do cadastro.",
    ),
  telegram_bot: z
    .string()
    .regex(/^@?\w*$/)
    .transform((v) => v.replace(/^@/, ""))
    .default("")
    .describe(
      "Usuário do bot no Telegram, sem @ (ex.: saybest_bot). Vazio: sem as opções de Telegram " +
        "no cadastro e no painel.",
    ),
  signup_connection: z
    .string()
    .default("meta-main")
    .describe("Conexão do WhatsApp em que os cadastros são ativados."),
  contact_text: z
    .string()
    .default("")
    .describe(
      "Como falar com você, mostrado a quem está bloqueado ou com o plano " +
        "vencido (ex.: 'Fale com a gente: contato@...').",
    ),
  rate_limit_per_minute: z
    .preprocess(lax, z.number().int().min(1).max(60).nullable())
    .default(null)
    .describe("Mensagens por minuto por aluno (vazio: padrão do servidor)."),
  session_idle_hours: z
    .preprocess(lax, z.number().min(0).max(720))
    .default(12)
    .describe("Horas sem mensagem até a conversa recomeçar (0: nunca)."),
  default_ui_lang: z
    .enum(["en", "pt"])
    .default("en")
    .describe("Idioma padrão das mensagens de ajuda e correção."),
  default_tutor: z
    .enum(["emma", "sarah", "george", "michael"])
    .default("sarah")
    .describe("Tutor padrão de quem começa."),
  timezone: z
    .string()
    .default("America/Sao_Paulo")
    .describe("Fuso usado para zerar o limite diário à meia-noite."),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function defaultRuntimeConfig(): RuntimeConfig {
  return RuntimeConfigSchema.parse({});
}
