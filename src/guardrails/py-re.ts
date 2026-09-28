/**
 * Regex and string helpers the guardrail rules depend on. In the rule patterns `\w`, `\b`, `\s`
 * and `\d` are Unicode-aware ("você", "inglês" are one word), `.` only excludes "\n" and `$`
 * also matches before a final "\n"; lengths count code points. `pyRe` translates those tokens
 * into a JS RegExp so the rule patterns can stay written that way.
 */

const W = "\\p{L}\\p{N}_"; // \w: letters, numbers and "_" (checked against every code point)
const S = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const OUTSIDE: Record<string, string> = {
  w: `[${W}]`,
  W: `[^${W}]`,
  b: `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`,
  s: `[${S}]`,
  S: `[^${S}]`,
  d: "\\p{Nd}",
  D: "\\P{Nd}",
};
const INSIDE: Record<string, string> = { w: W, s: S, d: "\\p{Nd}" };

/**
 * Compile a rule pattern with the semantics above as a JS RegExp (`u` flag added). With `i`,
 * "i"/"I" also match "İ" (U+0130) and "ı" (U+0131), which JS case folding does not do; every
 * other code point was checked to fold as intended for the letters used here.
 */
export function pyRe(source: string, flags = ""): RegExp {
  const dottedI = flags.includes("i");
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === "\\") {
      const next = source[++i] as string;
      const table = inClass ? INSIDE : OUTSIDE;
      if (inClass && "WSDB".includes(next)) throw new Error(`unsupported \\${next} in a class`);
      out += table[next] ?? `\\${next}`;
      if ("pPu".includes(next) && source[i + 1] === "{") {
        const close = source.indexOf("}", i);
        out += source.slice(i + 1, close + 1); // \p{L}, \u{1f000}: copied as is
        i = close;
      }
    } else if (dottedI && (c === "i" || c === "I")) {
      out += inClass ? "iI\u0130\u0131" : "[iI\u0130\u0131]";
    } else if (inClass) {
      if (c === "]") inClass = false;
      out += c;
    } else if (c === "[") {
      inClass = true;
      out += c;
      if (source[i + 1] === "^") out += source[++i];
    } else if (c === ".") {
      out += "[^\\n]";
    } else if (c === "$") {
      out += "(?=\\n?$)";
    } else {
      out += c;
    }
  }
  return new RegExp(out, `u${flags}`);
}

const SPACE_RE = new RegExp(`[${S}]+`, "u");
const SPACE_CHARS = new RegExp(`^[${S}]$`, "u");

/** Split on runs of Unicode whitespace, no empty strings. */
export function pySplit(text: string): string[] {
  return text.split(SPACE_RE).filter(Boolean);
}

/** Strip `chars` (Unicode whitespace when omitted) from both ends, or only the left/right. */
export function pyStrip(text: string, chars?: string, side: "both" | "l" | "r" = "both"): string {
  const drop = (ch: string) => (chars === undefined ? SPACE_CHARS.test(ch) : chars.includes(ch));
  const cps = Array.from(text);
  let start = 0;
  let end = cps.length;
  if (side !== "r") while (start < end && drop(cps[start] as string)) start++;
  if (side !== "l") while (end > start && drop(cps[end - 1] as string)) end--;
  return cps.slice(start, end).join("");
}

export const pyRstrip = (text: string, chars?: string) => pyStrip(text, chars, "r");

/** Length in code points, not UTF-16 units. */
export function pyLen(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
