/**
 * Tutors (a Kokoro voice + the name and hometown that go with it) and speaking speeds.
 *
 * The student picks both in the menu (/voz, /velocidade); they are kept in the conversation
 * state and survive /reset. Menu labels live in domain/texts.ts. The rest of the persona
 * (Toronto, graphic designer, cat Pixel) is shared and lives in the prompts. `persona` goes into
 * the prompts outside the delimiter tags, so it must stay a constant from this file, never
 * student text.
 */

export interface Tutor {
  readonly id: string;
  readonly name: string;
  readonly voice: string; // Kokoro voice id; 'b*' voices are British and use lang en-gb
  readonly persona: string; // "Emma, a woman, 29, grew up in Bristol, England"
  readonly accent: string; // key of Texts.accents
  readonly gender: string; // key of Texts.genders
}

const tutor = (
  id: string,
  name: string,
  voice: string,
  persona: string,
  accent: string,
  gender: string,
): Tutor => Object.freeze({ id, name, voice, persona, accent, gender });

// biome-ignore format: one tutor per line
export const TUTORS: Readonly<Record<string, Tutor>> = Object.freeze(
  Object.fromEntries(
    [
      tutor("emma", "Emma", "bf_emma", "Emma, a woman, 29, grew up in Bristol, England", "british", "female"),
      tutor("sarah", "Sarah", "af_heart", "Sarah, a woman, 29, grew up in Portland, Oregon, USA", "american", "female"),
      tutor("george", "George", "bm_george", "George, a man, 31, grew up in Manchester, England", "british", "male"),
      tutor("michael", "Michael", "am_michael", "Michael, a man, 31, grew up in Chicago, USA", "american", "male"),
    ].map((t) => [t.id, t]),
  ),
);
export const DEFAULT_TUTOR = "sarah";
// Spoken after a voice change when there is no last reply to replay in the new voice.
export const SAMPLE_LINE = "Hi, I'm {name}! Send me a voice message in English and let's talk.";

// Kokoro's speed factor. Steps of 0.1: 0.75 vs 0.8 is hard to hear; below 0.7 words stretch.
// A Map, not an object: integer-like keys would be reordered ("70" first) in a JS object.
export const SPEEDS: ReadonlyMap<string, number> = new Map([
  ["100", 1.0],
  ["90", 0.9],
  ["80", 0.8],
  ["70", 0.7],
]);
export const DEFAULT_SPEED = 1.0;

export function tutorOf(tutorId: string | null | undefined): Tutor {
  return TUTORS[tutorId ?? ""] ?? (TUTORS[DEFAULT_TUTOR] as Tutor);
}

/** 'george', 'George', '3' (position in the menu). */
export function parseTutor(arg: string): Tutor | null {
  const key = arg.trim().toLowerCase();
  const all = Object.values(TUTORS);
  if (/^[0-9]+$/.test(key)) {
    const n = Number(key);
    if (n >= 1 && n <= all.length) return all[n - 1] ?? null;
  }
  return Object.hasOwn(TUTORS, key) ? (TUTORS[key] ?? null) : null;
}

/** '80', '0.8', '0,8', '80%', '0.8x' -> 0.8; only the offered speeds. */
export function parseSpeed(arg: string): number | null {
  const text = arg
    .trim()
    .toLowerCase()
    .replace(/[%x]+$/, "")
    .replaceAll(",", ".");
  if (!text.trim()) return null;
  let value = Number(text);
  if (Number.isNaN(value)) return null;
  if (value > 2) value /= 100; // percent
  return [...SPEEDS.values()].find((s) => Math.abs(s - value) < 0.01) ?? null;
}

// --- what the student's plan offers (plans.tutors / plans.speeds; null: everything) ---------

export function tutorOffered(tutorId: string, offered: readonly string[] | null | undefined) {
  return !offered || offered.includes(tutorId);
}

export function speedOffered(speed: number, offered: readonly number[] | null | undefined) {
  return !offered || offered.some((s) => Math.abs(s - speed) < 0.01);
}

/** The chosen tutor when the plan offers it, else the first one it offers. The choice itself
 * stays saved, so it comes back on a plan that offers it. */
export function effectiveTutor(
  tutorId: string | null | undefined,
  offered: readonly string[] | null | undefined,
): Tutor {
  const chosen = tutorOf(tutorId);
  if (tutorOffered(chosen.id, offered)) return chosen;
  const first = Object.values(TUTORS).find((t) => tutorOffered(t.id, offered));
  return first ?? chosen;
}

/** The chosen speed when the plan offers it, else the closest one it offers. */
export function effectiveSpeed(speed: number, offered: readonly number[] | null | undefined) {
  if (speedOffered(speed, offered) || !offered?.length) return speed;
  return [...offered].sort((a, b) => Math.abs(a - speed) - Math.abs(b - speed))[0] ?? speed;
}
