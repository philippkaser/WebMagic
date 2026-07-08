import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONSTERS, Tile, TileMap } from '@webmagic/shared';
import { GameServer } from './game';
import { Zone } from './zone';
import { spawnMonster } from './spawn';
import type { PlayerStore } from '../persist/store';

const noopStore: PlayerStore = {
  init: async () => {},
  load: async () => null,
  save: async () => {},
  flush: async () => {},
};

function countVariant(zone: Zone, variant: string): number {
  let n = 0;
  for (const e of zone.entities.values()) if (e.variant === variant && !e.dead) n++;
  return n;
}

test('killing a slime in a dungeon splits it into two slimelets', () => {
  const game = new GameServer(noopStore);
  const zone = new Zone('test:1', 'dungeon', new TileMap(16, 16, Tile.Floor), []);
  const slime = spawnMonster(zone, MONSTERS.slime, 10, 10);

  assert.equal(countVariant(zone, 'slimelet'), 0);
  slime.dead = true;
  game.onEntityKilled(zone, slime, null);

  assert.equal(countVariant(zone, 'slimelet'), 2, 'a dead slime should leave two slimelets');
});

test('slimelets do not split further (no infinite slime cascade)', () => {
  const game = new GameServer(noopStore);
  const zone = new Zone('test:2', 'dungeon', new TileMap(16, 16, Tile.Floor), []);
  const slimelet = spawnMonster(zone, MONSTERS.slimelet, 5, 5);

  slimelet.dead = true;
  game.onEntityKilled(zone, slimelet, null);

  assert.equal(countVariant(zone, 'slimelet'), 0, 'the killed slimelet is dead and spawns nothing');
});

test('a plain skeleton does not spawn anything on death', () => {
  const game = new GameServer(noopStore);
  const zone = new Zone('test:3', 'dungeon', new TileMap(16, 16, Tile.Floor), []);
  const skele = spawnMonster(zone, MONSTERS.skeleton, 8, 8);
  const before = zone.entities.size;

  skele.dead = true;
  game.onEntityKilled(zone, skele, null);

  assert.equal(zone.entities.size, before, 'non-splitting monsters add no entities');
});
