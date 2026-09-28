/** Fernet encryption for connection credentials at rest (key in FERNET_KEY).
 *
 * Standard Fernet tokens (spec-compatible; existing stored credentials depend on it): url-safe
 * base64 (with "=" padding) of
 *   0x80 | timestamp (8 bytes, big endian) | IV (16) | AES-128-CBC/PKCS7 ciphertext | HMAC-SHA256 (32)
 * with the 32-byte key split into signing key (first 16) and encryption key (last 16). */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Secret } from "../config.js";

const VERSION = 0x80;

export class InvalidTokenError extends Error {
  override name = "InvalidToken";
}

function b64urlDecode(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new InvalidTokenError("not base64url");
  return Buffer.from(text, "base64url");
}

// Fernet tokens keep the "=" padding.
const b64urlEncode = (data: Buffer) =>
  data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

export class Fernet {
  private readonly signingKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(key: string) {
    const raw = /^[A-Za-z0-9_-]{43}=?$/.test(key) ? Buffer.from(key, "base64url") : null;
    if (raw?.length !== 32) {
      throw new Error("Fernet key must be 32 url-safe base64-encoded bytes.");
    }
    this.signingKey = raw.subarray(0, 16);
    this.encryptionKey = raw.subarray(16);
  }

  static generateKey(): string {
    return b64urlEncode(randomBytes(32));
  }

  encrypt(data: Buffer, now = Date.now(), iv: Buffer = randomBytes(16)): string {
    const cipher = createCipheriv("aes-128-cbc", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const header = Buffer.alloc(9);
    header[0] = VERSION;
    header.writeBigUInt64BE(BigInt(Math.floor(now / 1000)), 1);
    const signed = Buffer.concat([header, iv, ciphertext]);
    const mac = createHmac("sha256", this.signingKey).update(signed).digest();
    return b64urlEncode(Buffer.concat([signed, mac]));
  }

  decrypt(token: string): Buffer {
    const data = b64urlDecode(token);
    if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== VERSION) {
      throw new InvalidTokenError("malformed token");
    }
    const signed = data.subarray(0, data.length - 32);
    const mac = createHmac("sha256", this.signingKey).update(signed).digest();
    if (!timingSafeEqual(mac, data.subarray(data.length - 32))) {
      throw new InvalidTokenError("bad signature");
    }
    const iv = data.subarray(9, 25);
    try {
      const decipher = createDecipheriv("aes-128-cbc", this.encryptionKey, iv);
      return Buffer.concat([
        decipher.update(data.subarray(25, data.length - 32)),
        decipher.final(),
      ]);
    } catch {
      throw new InvalidTokenError("bad padding");
    }
  }
}

// The encrypted plaintext: JSON with ", " / ": " separators and non-ASCII as \uXXXX escapes
// (the format of the credentials already stored).
function credentialJson(value: Record<string, string>): string {
  const ascii = (s: string) =>
    JSON.stringify(s).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return `{${Object.entries(value)
    .map(([k, v]) => `${ascii(k)}: ${ascii(v)}`)
    .join(", ")}}`;
}

export class CredentialCipher {
  private readonly fernet: Fernet;

  constructor(key: string) {
    if (!key) throw new Error("FERNET_KEY is required to store channel credentials");
    this.fernet = new Fernet(key);
  }

  encrypt(credentials: Record<string, Secret>): string {
    const plain = Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, v.value]));
    return this.fernet.encrypt(Buffer.from(credentialJson(plain), "utf8"));
  }

  decrypt(token: string): Record<string, Secret> {
    let plain: Record<string, string>;
    try {
      plain = JSON.parse(this.fernet.decrypt(token).toString("utf8"));
    } catch (exc) {
      if (exc instanceof InvalidTokenError) {
        throw new Error("credentials cannot be decrypted (wrong FERNET_KEY?)");
      }
      throw exc;
    }
    return Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, new Secret(String(v))]));
  }
}
