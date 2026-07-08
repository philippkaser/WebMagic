import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAttributes,
  deriveStats,
  xpForLevel,
  zeroAttributes,
  zeroBonuses,
  BASE_MOVE_SPEED,
} from './stats';

test('zeroAttributes derive to the documented base line', () => {
  const s = deriveStats(zeroAttributes(), zeroBonuses());
  assert.equal(s.maxHp, 50);
  assert.equal(s.maxMp, 20);
  assert.equal(s.moveSpeed, BASE_MOVE_SPEED);
});

test('attributes scale derived stats', () => {
  const s = deriveStats({ str: 3, int: 4, vit: 5, armor: 2 }, zeroBonuses());
  assert.equal(s.maxHp, 50 + 5 * 10);
  assert.equal(s.maxMp, 20 + 4 * 6);
  assert.equal(s.meleePower, 3);
  assert.equal(s.spellPower, 4);
  assert.equal(s.armor, 2);
});

test('moveSpeed bonus is a percentage', () => {
  const s = deriveStats(zeroAttributes(), { ...zeroBonuses(), moveSpeed: 20 });
  assert.ok(Math.abs(s.moveSpeed - BASE_MOVE_SPEED * 1.2) < 1e-9);
});

test('addAttributes is additive and treats missing keys as zero', () => {
  const r = addAttributes({ str: 1, int: 2, vit: 3, armor: 4 }, { str: 10, vit: 5 });
  assert.deepEqual(r, { str: 11, int: 2, vit: 8, armor: 4 });
});

test('xpForLevel is positive and strictly increasing', () => {
  let prev = -1;
  for (let lvl = 1; lvl <= 50; lvl++) {
    const need = xpForLevel(lvl);
    assert.ok(need > 0, `level ${lvl} xp should be positive`);
    assert.ok(need > prev, `xp curve should increase at level ${lvl}`);
    prev = need;
  }
});
