import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

// scrypt instead of argon2 on purpose: no native module to compile, and it is
// memory-hard enough that a stolen hash is expensive to attack. Parameters are
// stored WITH the hash so they can be raised later without invalidating users.
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, , , , saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(keyB64!, "base64");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Refresh tokens are opaque random strings; only their hash is persisted. */
export function newOpaqueToken(): string {
  return randomBytes(48).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Device fingerprints are hashed with a server-side pepper before storage, so
 * the raw hardware identifiers never sit in the database.
 */
export function hashFingerprint(raw: string): string {
  const pepper = config.fingerprintPepper;
  if (!pepper) throw new Error("FINGERPRINT_PEPPER is not set");
  return createHmac("sha256", pepper).update(raw).digest("hex");
}
