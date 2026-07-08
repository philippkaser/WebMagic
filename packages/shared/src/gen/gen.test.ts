import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOverworld } from './worldgen';
import { generateDungeonFloor } from './dungeongen';
import { TileMap, Tile, TILE_SIZE, worldToTile } from '../tiles';

/** BFS over walkable tiles: can you reach tile `b` from tile `a`? */
function reachable(map: TileMap, ax: number, ay: number, bx: number, by: number): boolean {
  const seen = new Uint8Array(map.w * map.h);
  const queue: [number, number][] = [[ax, ay]];
  seen[ay * map.w + ax] = 1;
  while (queue.length) {
    const [x, y] = queue.pop()!;
    if (x === bx && y === by) return true;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (!map.inBounds(nx, ny)) continue;
      const idx = ny * map.w + nx;
      if (seen[idx] || map.blockedTile(nx, ny)) continue;
      seen[idx] = 1;
      queue.push([nx, ny]);
    }
  }
  return false;
}

// ---- overworld -------------------------------------------------------------

test('overworld generation is deterministic for a seed', () => {
  const a = generateOverworld(2024);
  const b = generateOverworld(2024);
  assert.deepEqual([...a.map.tiles], [...b.map.tiles], 'same seed -> identical tiles');
  assert.equal(a.villages.length, b.villages.length);
  assert.equal(a.portals.length, b.portals.length);
});

test('different seeds produce different worlds', () => {
  const a = generateOverworld(1);
  const b = generateOverworld(2);
  assert.notDeepEqual([...a.map.tiles], [...b.map.tiles]);
});

test('overworld has the expected landmarks and a solid border', () => {
  const w = generateOverworld(555);
  assert.equal(w.villages.length, 4);
  assert.equal(w.portals.length, 4);
  assert.ok(w.camps.length > 0);
  // Border ring is blocking so players cannot walk off the map.
  assert.ok(w.map.blockedTile(0, 0), 'corner is walled');
  assert.ok(w.map.blockedTile(w.map.w - 1, w.map.h - 1), 'far corner is walled');
});

test('overworld has rolling terrain elevation, flat around villages, deterministic', () => {
  const a = generateOverworld(4242);
  const b = generateOverworld(4242);
  assert.deepEqual([...a.map.heights], [...b.map.heights], 'heights are deterministic per seed');

  let maxLevel = 0;
  for (const h of a.map.heights) maxLevel = Math.max(maxLevel, h);
  assert.ok(maxLevel > 0, 'the wilds should have hills');

  // Village centres are flattened.
  for (const v of a.villages) {
    assert.equal(a.map.heightLevel(Math.round(v.cx), Math.round(v.cy)), 0, `${v.name} centre is flat`);
  }
});

test('elevationAtWorld interpolates smoothly between tile heights', () => {
  const m = new TileMap(4, 4, Tile.Grass);
  m.setHeight(1, 1, 0);
  m.setHeight(2, 1, 2); // a 2-level step to the east
  const west = m.elevationAtWorld(1.5 * TILE_SIZE, 1.5 * TILE_SIZE);
  const mid = m.elevationAtWorld(2.0 * TILE_SIZE, 1.5 * TILE_SIZE);
  const east = m.elevationAtWorld(2.5 * TILE_SIZE, 1.5 * TILE_SIZE);
  assert.ok(east > mid && mid > west, 'elevation ramps up across the step, not a hard jump');
});

test('every village inn spawn is on walkable ground', () => {
  const w = generateOverworld(31337);
  for (const v of w.villages) {
    assert.ok(!w.map.blockedAtWorld(v.innSpawn.x, v.innSpawn.y), `inn spawn for ${v.name} must be walkable`);
  }
});

// ---- dungeon ---------------------------------------------------------------

test('dungeon floor generation is deterministic for (seed, floor)', () => {
  const a = generateDungeonFloor(4242, 3);
  const b = generateDungeonFloor(4242, 3);
  assert.deepEqual([...a.map.tiles], [...b.map.tiles]);
});

test('consecutive floors of the same dungeon differ', () => {
  const f1 = generateDungeonFloor(4242, 1);
  const f2 = generateDungeonFloor(4242, 2);
  assert.notDeepEqual([...f1.map.tiles], [...f2.map.tiles]);
});

test('dungeon spawn, stairs and exit portal are placed and reachable from spawn', () => {
  for (let floor = 1; floor <= 6; floor++) {
    const d = generateDungeonFloor(9001, floor);
    const spawnTx = worldToTile(d.spawn.x);
    const spawnTy = worldToTile(d.spawn.y);
    const stairsTx = worldToTile(d.stairs.x);
    const stairsTy = worldToTile(d.stairs.y);

    assert.ok(!d.map.blockedAtWorld(d.spawn.x, d.spawn.y), `floor ${floor}: spawn walkable`);
    assert.equal(d.map.get(stairsTx, stairsTy), Tile.StairsDown, `floor ${floor}: stairs tile present`);
    assert.ok(
      reachable(d.map, spawnTx, spawnTy, stairsTx, stairsTy),
      `floor ${floor}: player must be able to reach the stairs`
    );
    assert.ok(d.monsterSpawns.length > 0, `floor ${floor}: has monsters`);
  }
});

test('dungeon floors place spike traps on walkable floor, sparing the entry', () => {
  for (let floor = 1; floor <= 5; floor++) {
    const d = generateDungeonFloor(2222, floor);
    let spikes = 0;
    for (const t of d.map.tiles) if (t === Tile.Spikes) spikes++;
    assert.ok(spikes > 0, `floor ${floor} should have spike traps`);
    // Spikes are walkable (jumpable), so they never block the route to the stairs.
    const spawnTx = worldToTile(d.spawn.x);
    const spawnTy = worldToTile(d.spawn.y);
    assert.notEqual(d.map.get(spawnTx, spawnTy), Tile.Spikes, 'never trap the spawn tile');
  }
});

test('the new dungeon monsters (slime, spider) appear across floors', () => {
  const seen = new Set<string>();
  for (let floor = 1; floor <= 6; floor++) {
    for (const s of generateDungeonFloor(31, floor).monsterSpawns) seen.add(s.monster);
  }
  assert.ok(seen.has('slime'), 'slimes should spawn');
  assert.ok(seen.has('spider'), 'spiders should spawn');
});

test('deeper dungeon floors grow and field more monsters', () => {
  const shallow = generateDungeonFloor(11, 1);
  const deep = generateDungeonFloor(11, 6);
  assert.ok(deep.map.w >= shallow.map.w, 'deeper floors are at least as large');
  assert.ok(
    deep.monsterSpawns.length >= shallow.monsterSpawns.length,
    'deeper floors field at least as many monsters'
  );
});
