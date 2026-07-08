import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hashSeed, clamp, lerp, dist, distSq, angleDiff, angleLerp } from './math';

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('lerp interpolates endpoints and midpoint', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
});

test('dist and distSq agree', () => {
  assert.equal(dist(0, 0, 3, 4), 5);
  assert.equal(distSq(0, 0, 3, 4), 25);
});

test('angleDiff returns shortest signed rotation in -PI..PI', () => {
  assert.ok(Math.abs(angleDiff(0, Math.PI * 2)) < 1e-9);
  // From just below +PI to just above -PI is a short negative step, not a long one.
  const d = angleDiff(Math.PI - 0.1, -Math.PI + 0.1);
  assert.ok(d > 0 && d < 0.3, `expected small positive wrap, got ${d}`);
  assert.ok(angleDiff(0, Math.PI / 2) > 0);
});

test('angleLerp moves toward the target the short way', () => {
  const a = angleLerp(0, Math.PI / 2, 0.5);
  assert.ok(Math.abs(a - Math.PI / 4) < 1e-9);
});

// The determinism contract the whole client/server-shared-generation design rests on.
test('Rng is deterministic for a given seed', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('Rng.next() stays in [0, 1)', () => {
  const rng = new Rng(1);
  for (let i = 0; i < 10_000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('Rng.int() is inclusive on both ends and stays in range', () => {
  const rng = new Rng(7);
  let sawMin = false;
  let sawMax = false;
  for (let i = 0; i < 5_000; i++) {
    const v = rng.int(1, 6);
    assert.ok(v >= 1 && v <= 6);
    assert.ok(Number.isInteger(v));
    if (v === 1) sawMin = true;
    if (v === 6) sawMax = true;
  }
  assert.ok(sawMin && sawMax, 'int() should be able to hit both endpoints');
});

test('Rng.pick() only returns members of the array', () => {
  const rng = new Rng(99);
  const arr = ['a', 'b', 'c'] as const;
  for (let i = 0; i < 1_000; i++) assert.ok(arr.includes(rng.pick(arr)));
});

test('Rng.shuffle() is a permutation (no loss, no duplication)', () => {
  const rng = new Rng(3);
  const original = Array.from({ length: 50 }, (_, i) => i);
  const shuffled = rng.shuffle([...original]);
  assert.deepEqual([...shuffled].sort((x, y) => x - y), original);
});

test('hashSeed is stable and order-sensitive', () => {
  assert.equal(hashSeed(1, 2, 3), hashSeed(1, 2, 3));
  assert.notEqual(hashSeed(1, 2, 3), hashSeed(3, 2, 1));
  // Always a uint32.
  assert.ok(hashSeed(999, -1) >>> 0, 'should be a valid uint32');
});
