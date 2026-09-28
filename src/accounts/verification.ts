/**
 * One-time codes that prove a phone number belongs to the person on the website.
 *
 * The site cannot message a new number first (Meta only allows approved templates for that), so
 * the student sends the code *to* the bot: "ATIVAR 482913" creates the account on the WhatsApp id
 * that sent it, "SENHA 482913" allows a new password. The site keeps a random `token` (in the URL
 * it polls) and never shows it to anyone else; the 6-digit code alone cannot log anybody in.
 *
 * Keys (shared cache, TTL CODE_TTL_S):
 *   verify:code:<kind>:<code>  -> JSON Pending (who asked, what to do)
 *   verify:token:<token>       -> JSON {"status": "pending"|"done"|"wrong_phone", "user_id": int}
 */

import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import type { Cache } from "../ports/cache.js";

export const CODE_TTL_S = 30 * 60;
export const Kind = z.enum(["signup", "reset"]);
export type Kind = z.infer<typeof Kind>;
// what the student sends; the site shows the Portuguese or English word for the kind
export const WORDS: Readonly<Record<string, Kind>> = {
  ativar: "signup",
  activate: "signup",
  senha: "reset",
  password: "reset",
  reset: "reset",
};
export const CODE_RE = new RegExp(
  String.raw`^\s*\/?(${Object.keys(WORDS).join("|")})\s*[:#-]?\s*(\d{6})\s*[.!]?\s*$`,
  "i",
);

export const Pending = z.object({
  kind: Kind,
  token: z.string(),
  phone: z.string(), // as typed on the site (checked loosely against the WhatsApp id)
  name: z.string().default(""),
  password_hash: z.string().default(""),
  user_id: z.number().int().nullable().default(null), // reset: the account
  lang: z.string().default("en"),
});
export type Pending = z.infer<typeof Pending>;

export const TokenStatus = z.object({
  status: z.enum(["pending", "done", "wrong_phone", "expired"]).default("pending"),
  user_id: z.number().int().nullable().default(null),
});
export type TokenStatus = z.infer<typeof TokenStatus>;

const toJson = (value: unknown) => Buffer.from(JSON.stringify(value));

/** 'ATIVAR 482913' -> ['signup', '482913']. */
export function parse(text: string | null | undefined): [Kind, string] | null {
  const match = CODE_RE.exec(text ?? "");
  if (!match) return null;
  const kind = WORDS[(match[1] ?? "").toLowerCase()];
  return kind && match[2] ? [kind, match[2]] : null;
}

/** Store a pending verification; returns the 6-digit code to show on the site. */
export async function start(cache: Cache, pending: z.input<typeof Pending>): Promise<string> {
  const value = Pending.parse(pending);
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(10 ** 6)).padStart(6, "0");
    if (await cache.setIfAbsent(`verify:code:${value.kind}:${code}`, toJson(value), CODE_TTL_S)) {
      await setStatus(cache, value.token, TokenStatus.parse({}));
      return code;
    }
  }
  throw new Error("no free verification code"); // 1e6 codes, 30 min TTL: never in practice
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The pending verification for this code, used at most once. */
export async function claim(cache: Cache, kind: Kind, code: string): Promise<Pending | null> {
  const key = `verify:code:${kind}:${code}`;
  const raw = await cache.get(key);
  if (raw === null || !(await cache.setIfAbsent(`${key}:used`, Buffer.from("1"), CODE_TTL_S))) {
    return null;
  }
  await cache.delete(key);
  return Pending.parse(JSON.parse(raw.toString("utf-8")));
}

export async function setStatus(
  cache: Cache,
  token: string,
  status: z.input<typeof TokenStatus>,
): Promise<void> {
  await cache.set(`verify:token:${token}`, toJson(TokenStatus.parse(status)), CODE_TTL_S);
}

export async function status(cache: Cache, token: string): Promise<TokenStatus> {
  const raw = await cache.get(`verify:token:${token}`);
  return raw && raw.length > 0
    ? TokenStatus.parse(JSON.parse(raw.toString("utf-8")))
    : TokenStatus.parse({ status: "expired" });
}
