import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../math';
import { generateItem, RARITY_ORDER, type Rarity } from './items';

const AFFIX_COUNT: Record<Rarity, number> = {
  common: 0,
  magic: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

test('forced rarity produces the implicit stat plus the right number of affixes', () => {
  const rng = new Rng(1);
  for (const rarity of RARITY_ORDER) {
    const item = generateItem(rng, 10, rarity);
    assert.equal(item.rarity, rarity);
    // affixes = 1 implicit slot stat + rarity affix count
    assert.equal(item.affixes.length, AFFIX_COUNT[rarity] + 1, `${rarity} affix count`);
  }
});

test('generated items are internally well-formed', () => {
  const rng = new Rng(42);
  for (let i = 0; i < 200; i++) {
    const item = generateItem(rng, rng.int(1, 40));
    assert.ok(item.id, 'has id');
    assert.ok(item.name.length > 0, 'has name');
    assert.ok(RARITY_ORDER.includes(item.rarity), 'valid rarity');
    assert.ok(item.ilvl >= 1, 'positive ilvl');
    for (const a of item.affixes) {
      assert.ok(a.value > 0, `affix ${a.stat} should be positive, got ${a.value}`);
      assert.ok(Number.isFinite(a.value));
    }
  }
});

test('item ids are unique across a batch', () => {
  const rng = new Rng(7);
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(generateItem(rng, 5).id);
  assert.equal(ids.size, 500, 'every generated item id should be unique');
});

test('higher item level yields stronger affixes on average', () => {
  const sum = (ilvl: number) => {
    const rng = new Rng(123);
    let total = 0;
    for (let i = 0; i < 300; i++) {
      for (const a of generateItem(rng, ilvl, 'rare').affixes) total += a.value;
    }
    return total;
  };
  assert.ok(sum(40) > sum(5), 'ilvl 40 items should out-stat ilvl 5 items');
});
