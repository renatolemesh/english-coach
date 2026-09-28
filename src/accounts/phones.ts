/**
 * Phone numbers as WhatsApp sends them: digits only, country code first.
 *
 * Brazilian mobile numbers may arrive without the ninth digit (WhatsApp ids registered before
 * 2012: 55 11 87654321 instead of 55 11 987654321), so a number typed on the site and the id
 * WhatsApp uses can differ. The web signup never trusts the typed number: the account is linked
 * to the id that sends the activation code. For login, `variants` tries both forms.
 */

const NON_DIGITS = /\D/g;
export const BR = "55";

export function digits(phone: string | null | undefined): string {
  return (phone ?? "").replace(NON_DIGITS, "");
}

/** Digits of a full number (country code first), without leading zeros. */
export function normalize(phone: string | null | undefined): string {
  return digits(phone).replace(/^0+/, "");
}

export const PHONE_HINT = "Use o número completo, com DDI e DDD. Ex.: +55 11 98765-4321.";

/**
 * A number typed on the site, only if it is complete: country code + area code + number.
 * '+55 11 98765-4321', '5511987654321' and '+55 11 8765-4321' -> '5511987654321' (Brazilian
 * mobiles always with the ninth digit; `variants` still matches both forms); '11 98765-4321' -> null (no
 * country code). Other countries need a '+' (or '00'): without it, '41 9883...' could be a
 * Brazilian number missing the 55 or a Swiss one.
 */
export function fromForm(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  const international = raw.startsWith("+") || raw.startsWith("00");
  const d = normalize(raw);
  if (d.startsWith(BR)) {
    if (d.length === 13) return d;
    if (d.length !== 12) return null;
    // mobile typed without the ninth digit (old habit, and how WhatsApp sends old ids): add it
    return "6789".includes(d.charAt(4)) ? `${d.slice(0, 4)}9${d.slice(4)}` : d;
  }
  return international && d.length >= 10 && d.length <= 15 ? d : null;
}

/** The number and its Brazilian mobile twin (with/without the ninth digit). */
export function variants(phone: string | null | undefined): string[] {
  const d = normalize(phone);
  const out = [d];
  if (d.startsWith(BR) && d.length === 13 && d[4] === "9") {
    out.push(d.slice(0, 4) + d.slice(5));
  } else if (d.startsWith(BR) && d.length === 12 && "6789".includes(d.charAt(4))) {
    out.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  }
  return out;
}

export function samePhone(a: string, b: string): boolean {
  const other = new Set(variants(b));
  return variants(a).some((v) => other.has(v));
}
