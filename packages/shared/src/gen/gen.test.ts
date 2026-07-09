import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOverworld } from './worldgen';
import { generateDungeonFloor } from './dungeongen';
import { Biome, TileMap, Tile, TILE_SIZE, worldToTile } from '../tiles';

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
  assert.equal(w.villages.length, 6);
  assert.equal(w.portals.length, 4);
  assert.ok(w.camps.length > 0);
  assert.ok(w.pois.length > 0, 'wilderness landmarks exist');
  assert.ok(w.pois.some((p) => p.kind === 'shrine'), 'has a shrine');
  assert.ok(w.pois.some((p) => p.kind === 'obelisk'), 'has an obelisk');
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

// ---- biomes + regions -------------------------------------------------------

test('biome layer is deterministic and covers multiple biomes', () => {
  const a = generateOverworld(777);
  const b = generateOverworld(777);
  assert.deepEqual([...a.map.biomes], [...b.map.biomes], 'same seed -> identical biomes');

  const seen = new Set<number>();
  for (const bio of a.map.biomes) seen.add(bio);
  assert.ok(seen.has(Biome.Meadow), 'has meadow');
  assert.ok(seen.has(Biome.Forest), 'has forest');
  assert.ok(seen.size >= 3, 'the world has at least three biome kinds');
});

test('named regions exist, are deterministic, and forests are among them', () => {
  const a = generateOverworld(777);
  const b = generateOverworld(777);
  assert.deepEqual(a.regions, b.regions, 'regions (and their names) are deterministic');
  assert.ok(a.regions.length > 0, 'the wilds have named regions');
  assert.ok(a.regions.some((r) => r.kind === 'forest'), 'at least one named forest');
  for (const r of a.regions) {
    assert.ok(r.name.length > 0, 'every region has a name');
    assert.ok(r.tiles >= 50, 'regions are substantial');
    assert.ok(a.map.inBounds(r.cx, r.cy), 'region centroid is on the map');
  }
});

test('villages sit on tamed meadow; wolf dens live inside named forests', () => {
  const w = generateOverworld(4321);
  for (const v of w.villages) {
    assert.equal(w.map.biomeAt(v.cx, v.cy), Biome.Meadow, `${v.name} is on meadow`);
  }
  const dens = w.camps.filter((c) => c.monster === 'wolf');
  assert.ok(dens.length > 0, 'there are wolf dens');
  for (const den of dens) {
    assert.notEqual(den.regionId, undefined, 'wolf dens belong to a region');
    const region = w.regions.find((r) => r.id === den.regionId);
    assert.ok(region && region.kind === 'forest', 'wolf dens are in forests');
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
