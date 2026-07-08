import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Passphrase hashing for character accounts. Nimble by design — Node's built-in
 * scrypt, no external dependency. Stored as `salt:hash` in hex; a per-record
 * random salt means identical passphrases hash differently.
 */

const KEY_LEN = 32;

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time verification. Returns false for malformed stored values. */
export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(passphrase, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
