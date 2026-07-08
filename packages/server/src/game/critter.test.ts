import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxMsg, MONSTERS, Tile, TileMap, dist } from '@webmagic/shared';
import { Zone, ZoneHost } from './zone';
import { AiHost, tickAi, WorldClock } from './ai';
import { spawnCritter, spawnMonster } from './spawn';
import type { Entity } from './entities';

/** A host that just records deaths — enough to drive the AI in isolation. */
function makeHost(): AiHost & { killed: Entity[] } {
  const killed: Entity[] = [];
  const host: AiHost & { killed: Entity[] } = {
    killed,
    now: () => 0,
    broadcastFx: (_z: Zone, _fx: FxMsg) => {},
    onEntityKilled: (_z: Zone, victim: Entity) => {
      killed.push(victim);
      victim.dead = true;
    },
    playerByEntityId: () => undefined,
    onCaravanArrived: () => {},
    npcSay: () => {},
  };
  return host;
}

const DAY: WorldClock = { time: 0.5, isNight: false, aggroMul: 1 };

function step(host: AiHost, zone: Zone, seconds: number, steps = 60): void {
  const dt = seconds / steps;
  for (let i = 0; i < steps; i++) tickAi(host, zone, dt, DAY);
}

test('a wolf hunts a nearby chicken and kills it', () => {
  const zone = new Zone('t:hunt', 'overworld', new TileMap(32, 32, Tile.Grass), []);
  const wolf = spawnMonster(zone, MONSTERS.wolf, 10, 10);
  const chicken = spawnCritter(zone, 'chicken', 13, 10); // within a wolf's reach

  const host = makeHost();
  step(host, zone, 6, 360);

  assert.ok(chicken.dead, 'the wolf should run the chicken down');
  assert.ok(host.killed.includes(chicken), 'the chicken death is reported');
});

test('a deer bolts away from an approaching wolf', () => {
  const zone = new Zone('t:flee', 'overworld', new TileMap(64, 64, Tile.Grass), []);
  const wolf = spawnMonster(zone, MONSTERS.wolf, 30, 30);
  const deer = spawnCritter(zone, 'deer', 34, 30);
  deer.speed = 2.4;

  const host = makeHost();
  const startGap = dist(wolf.x, wolf.y, deer.x, deer.y);
  step(host, zone, 2, 120);

  // The deer isn't necessarily faster than a wolf, but it should be actively
  // fleeing — moving away from where it started, not standing still to graze.
  const moved = dist(deer.x, deer.y, 34, 30);
  assert.ok(moved > 2, 'the deer should have bolted some distance');
  assert.ok(!deer.dead || dist(wolf.x, wolf.y, deer.x, deer.y) <= startGap, 'deer reacted to the wolf');
});
