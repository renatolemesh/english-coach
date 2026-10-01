/**
 * Interactive choices sent to the student: quick-reply buttons or a list (WhatsApp menus).
 *
 * An option id is a command: a tap comes back from the channel as the text "/<command> <arg>"
 * ("tema:2" -> "/tema 2"), so taps and typed commands take the same path through the graph.
 * Channels without interactive messages send `fallbackText` instead.
 */

import { formatText, type Texts } from "./texts.js";
import { LEVELS, SUGGESTED_TOPICS } from "./topics.js";
import { SPEEDS, speedOffered, TUTORS, type Tutor, tutorOffered } from "./tutors.js";

export const MAX_BUTTONS = 3; // WhatsApp limits
export const MAX_ROWS = 10;
export const BUTTON_TITLE_CHARS = 20;
export const ROW_TITLE_CHARS = 24;
export const ROW_DESCRIPTION_CHARS = 72;

// biome-ignore format: one line
export const OPTION_COMMANDS = [
  "transcrever", "traduzir", "menu", "reset", "tema", "nivel", "voz", "velocidade", "idioma",
  "meta", "aula", "revisar", "sair", "ex", "lembretes", "resume",
] as const;
const OPTION_RE = new RegExp(`^(${OPTION_COMMANDS.join("|")})(?::([A-Za-z0-9]{1,8}))?$`);

export interface Option {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export interface Choice {
  readonly body: string;
  readonly options: readonly Option[];
  readonly fallbackText: string;
  readonly button: string; // set: a list opened by this button; empty: reply buttons
}

export function option(id: string, title: string, description = ""): Option {
  return { id, title, description };
}

export function isList(choice: Choice): boolean {
  return Boolean(choice.button);
}

/** 'tema:2' -> '/tema 2'; null for anything that is not one of our option ids. */
export function commandForOption(optionId: string | null | undefined): string | null {
  const match = OPTION_RE.exec(optionId ?? "");
  if (!match) return null;
  const [, command, arg] = match;
  return arg ? `/${command} ${arg}` : `/${command}`;
}

// First letter upper, the rest lower.
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// --- the choices the bot sends (in the student's language, domain/texts.ts) ----------------

export function voiceHelp(t: Texts): Choice {
  const ids = ["transcrever", "traduzir", "menu"] as const;
  return {
    body: t.voiceHelpBody,
    button: "",
    options: ids.map((id, i) => option(id, t.voiceHelpTitles[i] ?? "")),
    fallbackText: t.voiceHelpFallback,
  };
}

/** A list: WhatsApp allows at most 3 reply buttons. */
export function mainMenu(t: Texts): Choice {
  return {
    body: t.menuBody,
    button: t.menuButton,
    options: Object.entries(t.menuRows).map(([id, [title, desc]]) => option(id, title, desc)),
    fallbackText: t.menuFallback,
  };
}

export function topicMenu(t: Texts, current: string): Choice {
  return {
    body: formatText(t.topicBody, { current, cmd: t.cmdTopic }),
    button: t.topicButton,
    options: SUGGESTED_TOPICS.map((topic, i) =>
      option(`tema:${i + 1}`, topic.slice(0, ROW_TITLE_CHARS), t.topicNames[topic] ?? ""),
    ),
    fallbackText: t.topicList,
  };
}

export function levelMenu(t: Texts, current: string, fallbackText: string): Choice {
  return {
    body: formatText(t.levelBody, { current }),
    button: t.levelButton,
    options: LEVELS.map((lv) => option(`nivel:${lv}`, lv, t.levelNames[lv] ?? "")),
    fallbackText,
  };
}

export function tutorMenu(
  t: Texts,
  current: Tutor,
  offered: readonly string[] | null = null,
): Choice {
  const label = (tutor: Tutor) => capitalize(t.tutorDescription(tutor.accent, tutor.gender));
  const locked = (tutor: Tutor) => (tutorOffered(tutor.id, offered) ? "" : ` · ${t.paidOnly}`);
  const tutors = Object.values(TUTORS);
  const rows = tutors
    .map((x) => `${t.cmdVoice} ${x.id} - ${x.name}: ${label(x)}${locked(x)}`)
    .join("\n");
  const body = formatText(t.tutorBody, { current: current.name });
  return {
    body,
    button: t.tutorButton,
    options: tutors.map((x) => option(`voz:${x.id}`, x.name, `${label(x)}${locked(x)}`)),
    fallbackText: `${body}\n${rows}`,
  };
}

export function speedMenu(
  t: Texts,
  current: number,
  offered: readonly number[] | null = null,
): Choice {
  const speeds = [...SPEEDS];
  const name = (key: string, v: number) =>
    `${t.speedNames[key] ?? ""}${speedOffered(v, offered) ? "" : ` · ${t.paidOnly}`}`;
  const rows = speeds
    .map(([key, v]) => `${t.cmdSpeed} ${key} - ${t.speedLabel(v)} (${name(key, v)})`)
    .join("\n");
  const body = formatText(t.speedBody, { current: t.speedLabel(current) });
  return {
    body,
    button: t.speedButton,
    options: speeds.map(([key, v]) => option(`velocidade:${key}`, t.speedLabel(v), name(key, v))),
    fallbackText: `${body}\n${rows}`,
  };
}

export function remindersMenu(t: Texts, on: boolean): Choice {
  const body = formatText(t.remindersShow, { state: t.remindersState[on ? 0 : 1] });
  return {
    body,
    button: "",
    options: [
      option("lembretes:on", t.remindersButtons[0]),
      option("lembretes:off", t.remindersButtons[1]),
    ],
    fallbackText: `${body}\n/lembretes on · /lembretes off`,
  };
}

export function languageMenu(t: Texts): Choice {
  return {
    body: t.languageBody,
    button: "",
    options: [option("idioma:en", "🇬🇧 English"), option("idioma:pt", "🇧🇷 Português")],
    fallbackText: `${t.languageBody}\n/idioma en - English\n/idioma pt - Português`,
  };
}
