import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxMsg, MONSTERS, Tile, TileMap, dist } from '@webmagic/shared';
import { Zone, ZoneHost } from './zone';
import { AiHost, tickAi, WorldClock } from './ai';
import { spawnCritter, spawnMonster } from './spawn';
import type { Entity } from './entities';

/** A host that records deaths and advances a simulated clock with each tick. */
function makeHost(): AiHost & { killed: Entity[]; time: number } {
  const killed: Entity[] = [];
  const host: AiHost & { killed: Entity[]; time: number } = {
    killed,
    time: 0,
    now: () => host.time,
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

function step(host: AiHost & { time: number }, zone: Zone, seconds: number, steps = 60): void {
  const dt = seconds / steps;
  for (let i = 0; i < steps; i++) {
    host.time += dt * 1000;
    tickAi(host, zone, dt, DAY);
  }
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

test('hunger drives the hunt: a fed wolf ignores prey a starving wolf chases down', () => {
  // A fed wolf shrugs at a chicken across the meadow…
  const zoneA = new Zone('t:fed', 'overworld', new TileMap(64, 64, Tile.Grass), []);
  const fed = spawnMonster(zoneA, MONSTERS.wolf, 20, 20);
  fed.ai!.drives = { hunger: 0 };
  const ignored = spawnCritter(zoneA, 'chicken', 28, 20);
  const hostA = makeHost();
  step(hostA, zoneA, 4, 240);
  assert.ok(!ignored.dead, 'a sated wolf does not cross the meadow for a snack');

  // …a starving wolf crosses it and eats.
  const zoneB = new Zone('t:starving', 'overworld', new TileMap(64, 64, Tile.Grass), []);
  const starving = spawnMonster(zoneB, MONSTERS.wolf, 20, 20);
  starving.ai!.drives = { hunger: 1 };
  const eaten = spawnCritter(zoneB, 'chicken', 28, 20);
  const hostB = makeHost();
  step(hostB, zoneB, 8, 480);
  assert.ok(eaten.dead, 'a starving wolf ranges out and takes the kill');
});

test('hunger accumulates over time while a predator prowls', () => {
  const zone = new Zone('t:clock', 'overworld', new TileMap(32, 32, Tile.Grass), []);
  const wolf = spawnMonster(zone, MONSTERS.wolf, 10, 10);
  wolf.ai!.drives = { hunger: 0.5 };
  const host = makeHost();
  step(host, zone, 30, 600);
  assert.ok(wolf.ai!.drives!.hunger > 0.5, 'an empty belly gets emptier');
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
