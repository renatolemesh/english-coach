/**
 * Password hashing with scrypt (memory-hard). Stored format: scrypt$n$r$p$salt$hash, with n, r, p
 * in decimal and salt and hash in lowercase hex; hashes already in the database use it, so keep it.
 */

import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

export const N = 2 ** 14;
export const R = 8;
export const P = 1;
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128; // scrypt cost does not grow with length, but bound request sizes anyway
const KEY_LEN = 32;
// Node refuses when 128*N*r*p gets near maxmem (32 MiB default); leave room like OpenSSL does.
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(password, "utf8"), salt, KEY_LEN, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// Length in code points, not UTF-16 units.
const length = (text: string) => Array.from(text).length;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derive(password, salt, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${digest.toString("hex")}`;
}

const INT = /^[0-9]+$/;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored || length(password) > MAX_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [scheme, n, r, p, salt, digest] = parts as [string, string, string, string, string, string];
  if (scheme !== "scrypt" || !INT.test(n) || !INT.test(r) || !INT.test(p) || !HEX.test(salt)) {
    return false;
  }
  let candidate: Buffer;
  try {
    const opts = { N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEM };
    candidate = await derive(password, Buffer.from(salt, "hex"), opts);
  } catch {
    return false; // N not a power of 2, too much memory...
  }
  // compared as hex text, like hmac.compare_digest(candidate.hex(), digest)
  const a = Buffer.from(candidate.toString("hex"));
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Why a new password is refused (a key of the password rules texts), or null. */
export function passwordProblem(password: string): "too_short" | "too_long" | null {
  if (length(password) < MIN_LENGTH) return "too_short";
  if (length(password) > MAX_LENGTH) return "too_long";
  return null;
}
