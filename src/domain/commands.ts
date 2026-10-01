/** Slash commands: the words students type (or taps send) and what they mean. */
import { parseSpeed, parseTutor, speedOffered, tutorOffered } from "./tutors.js";

// biome-ignore format: grouped by meaning
export const ALIASES: Readonly<Record<string, string>> = {
  tema: "topic", topic: "topic",
  nivel: "level", "nível": "level", level: "level",
  ajuda: "help", help: "help",
  reset: "reset", start: "start",
  transcrever: "transcribe", "transcrição": "transcribe", transcricao: "transcribe",
  texto: "transcribe", transcribe: "transcribe",
  traduzir: "translate", "tradução": "translate", traducao: "translate",
  translate: "translate",
  menu: "menu", resume: "resume",
  voz: "voice", voice: "voice", tutor: "voice", professor: "voice",
  velocidade: "speed", speed: "speed", devagar: "speed",
  idioma: "language", language: "language", lang: "language", lingua: "language",
  "língua": "language",
  meta: "goal", metas: "goal", goal: "goal", progresso: "goal", progress: "goal",
  lembrete: "reminders", lembretes: "reminders", reminder: "reminders", reminders: "reminders",
};

// No LLM call: menus and fixed texts. They do not count against the per-minute rate limit,
// so a student browsing the menus is never told to slow down.
export const FREE_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "menu",
  "level",
  "transcribe",
  "language",
  "goal", // counts in the database, no LLM
  "reminders",
]);

/** "/lembretes off" -> false; null when the argument is not an on/off word. */
export function parseToggle(arg: string): boolean | null {
  const word = arg.trim().toLowerCase();
  if (/^(on|ligar|ligado|ligados|sim|yes|ativar)$/.test(word)) return true;
  if (/^(off|desligar|desligado|desligados|n[aã]o|no|parar|desativar)$/.test(word)) return false;
  return null;
}

export function canonical(name: string): string {
  const key = name.toLowerCase();
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? "unknown") : "unknown";
}

export function isFree(name: string, arg: string): boolean {
  const command = canonical(name);
  // without an argument these only show a menu; with one, /voz and /velocidade run TTS
  const menuOnly = ["topic", "voice", "speed"].includes(command) && !arg.trim();
  return FREE_COMMANDS.has(command) || menuOnly;
}

/** /voz or /velocidade with a choice the student's plan does not offer: a fixed answer, no TTS,
 * so it is free like a menu. */
export function lockedPick(
  name: string,
  arg: string,
  tutors: readonly string[] | null | undefined,
  speeds: readonly number[] | null | undefined,
): boolean {
  const command = canonical(name);
  if (command === "voice") {
    const tutor = parseTutor(arg);
    return tutor !== null && !tutorOffered(tutor.id, tutors);
  }
  if (command === "speed") {
    const speed = parseSpeed(arg);
    return speed !== null && !speedOffered(speed, speeds);
  }
  return false;
}
