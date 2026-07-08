import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassphrase, verifyPassphrase } from './auth';

test('a passphrase verifies against its own hash', () => {
  const stored = hashPassphrase('correct horse battery');
  assert.ok(verifyPassphrase('correct horse battery', stored));
});

test('a wrong passphrase does not verify', () => {
  const stored = hashPassphrase('the-real-one');
  assert.ok(!verifyPassphrase('not-it', stored));
  assert.ok(!verifyPassphrase('', stored));
});

test('the same passphrase hashes differently each time (random salt)', () => {
  const a = hashPassphrase('same-pass');
  const b = hashPassphrase('same-pass');
  assert.notEqual(a, b);
  // …but both still verify.
  assert.ok(verifyPassphrase('same-pass', a));
  assert.ok(verifyPassphrase('same-pass', b));
});

test('malformed stored values are rejected, not crashed on', () => {
  assert.ok(!verifyPassphrase('x', ''));
  assert.ok(!verifyPassphrase('x', 'nosalt'));
  assert.ok(!verifyPassphrase('x', ':abcd'));
  assert.ok(!verifyPassphrase('x', 'abcd:'));
});
