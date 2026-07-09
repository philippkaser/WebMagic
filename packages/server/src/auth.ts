import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pass: string, salt: Buffer, keylen: number) => Promise<Buffer>;

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

// Async variants for the connection path: scrypt is deliberately expensive, so
// hashing on the event loop would let a login burst (e.g. every client
// auto-reconnecting after a restart) stall the tick loop.

export async function hashPassphraseAsync(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(passphrase, salt, KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassphraseAsync(passphrase: string, stored: string): Promise<boolean> {
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const salt = Buffer.from(stored.slice(0, sep), 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scryptAsync(passphrase, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
