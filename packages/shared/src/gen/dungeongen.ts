import { Rng, hashSeed, Vec2, dist } from '../math';
import { Tile, TileMap, tileCenter } from '../tiles';
import type { MonsterId } from '../content/monsters';

export interface MonsterSpawnDef {
  x: number; // world coords
  y: number;
  monster: MonsterId;
}

export interface DungeonFloorData {
  map: TileMap;
  /** Player entry point, world coords. */
  spawn: Vec2;
  /** Stairs to the next floor, world coords. */
  stairs: Vec2;
  /** Exit portal location (world coords) — null on floors where leaving is not allowed. */
  exitPortal: Vec2 | null;
  torches: Vec2[];
  monsterSpawns: MonsterSpawnDef[];
  /** Floor loot piles (world coords). */
  lootSpawns: Vec2[];
}

/** Floors a player must complete before the exit portal lets them keep loot. */
export const DUNGEON_KEEP_FLOORS = 2;

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

function roomCenter(r: Room): Vec2 {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

/**
 * Generate one dungeon floor deterministically from (dungeonSeed, floor).
 * Classic rooms-and-corridors: every floor gets an entry room, a stairs room
 * (farthest from entry), torch-lit walls, monsters and loot scaling with depth.
 */
export function generateDungeonFloor(dungeonSeed: number, floor: number): DungeonFloorData {
  const rng = new Rng(hashSeed(dungeonSeed, floor, 0x0d));
  const size = 56 + Math.min(24, floor * 4);
  const map = new TileMap(size, size, Tile.Wall);

  // --- rooms
  const rooms: Room[] = [];
  const target = 7 + Math.min(6, floor);
  let attempts = 0;
  while (rooms.length < target && attempts < 300) {
    attempts++;
    const w = rng.int(5, 10);
    const h = rng.int(5, 10);
    const x = rng.int(2, size - w - 3);
    const y = rng.int(2, size - h - 3);
    if (rooms.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y)) {
      continue;
    }
    rooms.push({ x, y, w, h });
    for (let tx = x; tx < x + w; tx++) {
      for (let ty = y; ty < y + h; ty++) map.set(tx, ty, Tile.Floor);
    }
  }

  // --- corridors: connect each room to the next (rooms are in random order,
  // which produces winding, loopy layouts)
  for (let i = 1; i < rooms.length; i++) {
    const a = roomCenter(rooms[i - 1]);
    const b = roomCenter(rooms[i]);
    carveCorridor(map, rng, a, b);
  }
  // one extra loop for tactical routing
  if (rooms.length > 3) {
    carveCorridor(map, rng, roomCenter(rooms[0]), roomCenter(rooms[rooms.length - 2]));
  }

  // --- entry / stairs
  const entryRoom = rooms[0];
  const entry = roomCenter(entryRoom);
  let stairsRoom = rooms[rooms.length - 1];
  let best = -1;
  for (const r of rooms.slice(1)) {
    const c = roomCenter(r);
    const d = dist(c.x, c.y, entry.x, entry.y);
    if (d > best) {
      best = d;
      stairsRoom = r;
    }
  }
  const stairsT = roomCenter(stairsRoom);
  map.set(stairsT.x, stairsT.y, Tile.StairsDown);

  // --- exit portal in the entry room (activation gated by DUNGEON_KEEP_FLOORS)
  const exitT = { x: entryRoom.x + 1, y: entryRoom.y + 1 };
  map.set(exitT.x, exitT.y, Tile.PortalPad);

  // --- torches along room walls (sparse — darkness is the point)
  const torches: Vec2[] = [];
  for (const r of rooms) {
    const c = roomCenter(r);
    if (rng.chance(0.7)) torches.push(tileCenter(c.x, r.y)); // north wall
    if (rng.chance(0.35)) torches.push(tileCenter(r.x, c.y)); // west wall
  }
  torches.push(tileCenter(entry.x, entry.y));
  torches.push(tileCenter(stairsT.x, stairsT.y));

  // --- monsters: skip the entry room; the stairs room gets a guardian pack
  const monsterSpawns: MonsterSpawnDef[] = [];
  const pool: MonsterId[] = floor < 2 ? ['skeleton', 'skeleton', 'imp'] : ['skeleton', 'imp', 'imp', 'ogre'];
  for (const r of rooms) {
    if (r === entryRoom) continue;
    const isStairsRoom = r === stairsRoom;
    const count = isStairsRoom ? rng.int(3, 4) : rng.int(1, 3);
    for (let i = 0; i < count; i++) {
      const tx = rng.int(r.x + 1, r.x + r.w - 2);
      const ty = rng.int(r.y + 1, r.y + r.h - 2);
      const c = tileCenter(tx, ty);
      const monster: MonsterId = isStairsRoom && i === 0 && floor >= 2 ? 'ogre' : rng.pick(pool);
      monsterSpawns.push({ x: c.x, y: c.y, monster });
    }
  }

  // --- loot piles
  const lootSpawns: Vec2[] = [];
  for (const r of rooms) {
    if (r === entryRoom) continue;
    if (rng.chance(0.4)) {
      const tx = rng.int(r.x + 1, r.x + r.w - 2);
      const ty = rng.int(r.y + 1, r.y + r.h - 2);
      lootSpawns.push(tileCenter(tx, ty));
    }
  }

  return {
    map,
    spawn: tileCenter(entry.x, entry.y + 1),
    stairs: tileCenter(stairsT.x, stairsT.y),
    exitPortal: tileCenter(exitT.x, exitT.y),
    torches,
    monsterSpawns,
    lootSpawns,
  };
}

function carveCorridor(map: TileMap, rng: Rng, a: Vec2, b: Vec2) {
  let { x, y } = a;
  const horizontalFirst = rng.chance(0.5);
  const carve = (cx: number, cy: number) => {
    map.set(cx, cy, Tile.Floor);
    // 2-wide corridors feel better in first person
    map.set(cx + 1, cy, map.get(cx + 1, cy) === Tile.Wall ? Tile.Floor : map.get(cx + 1, cy));
  };
  if (horizontalFirst) {
    while (x !== b.x) { x += Math.sign(b.x - x); carve(x, y); }
    while (y !== b.y) { y += Math.sign(b.y - y); carve(x, y); }
  } else {
    while (y !== b.y) { y += Math.sign(b.y - y); carve(x, y); }
    while (x !== b.x) { x += Math.sign(b.x - x); carve(x, y); }
  }
}
