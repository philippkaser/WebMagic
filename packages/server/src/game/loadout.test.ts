import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_SKILLS, type Item } from '@webmagic/shared';
import { Player, type PlayerRecord } from './player';

function makePlayer(classId: PlayerRecord['classId'], level = 1): Player {
  return new Player({ name: 'T', classId, level, xp: 0, inventory: [], equipment: {}, x: 0, y: 0 });
}

const staff: Item = {
  id: 'w-staff',
  name: 'Test Staff',
  slot: 'weapon',
  rarity: 'common',
  ilvl: 5,
  affixes: [],
  weaponSkills: WEAPON_SKILLS.Staff,
};

test('with no weapon, LMB is the class primary and E/Q are the class skills', () => {
  const p = makePlayer('warrior');
  assert.deepEqual(p.loadout(), ['slash', null, 'slash', 'whirlwind']);
  assert.ok(p.canCast('slash'));
  assert.ok(!p.canCast('firebolt'), 'cannot cast a skill not in the loadout');
});

test('a class skill on E/Q respects its unlock level', () => {
  assert.ok(!makePlayer('warrior', 1).canCast('whirlwind'), 'whirlwind locked at level 1');
  assert.ok(makePlayer('warrior', 4).canCast('whirlwind'), 'whirlwind usable at level 4');
});

test('equipping a weapon rebinds LMB/RMB to the weapon skills', () => {
  const p = makePlayer('warrior', 1);
  p.inventory.push(staff);
  assert.ok(p.equip('w-staff'));
  assert.deepEqual(p.loadout(), ['firebolt', 'frost_nova', 'slash', 'whirlwind']);
});

test('weapon skills ignore level gates — a level-1 hero fires a staff frost nova', () => {
  const p = makePlayer('warrior', 1);
  p.inventory.push(staff);
  p.equip('w-staff');
  assert.ok(p.canCast('firebolt'), 'weapon primary usable immediately');
  assert.ok(p.canCast('frost_nova'), 'weapon secondary usable despite its class unlock level of 4');
});

test('any class can wield any weapon (a warrior casts staff spells)', () => {
  const p = makePlayer('warrior', 1);
  p.inventory.push(staff);
  p.equip('w-staff');
  assert.equal(p.loadout()[0], 'firebolt');
});
