import { Rng, hashSeed, Vec2, dist } from '../math';
import { Tile, TileMap, tileCenter } from '../tiles';
import type { MonsterId } from '../content/monsters';

export interface HouseDef {
  x: number; // tile coords of top-left wall
  y: number;
  w: number;
  h: number;
  door: Vec2; // tile coords
  isInn: boolean;
}

export interface VillageDef {
  id: number;
  name: string;
  cx: number; // tile coords of center
  cy: number;
  radius: number; // tiles
  houses: HouseDef[];
  /** World-space respawn point inside the inn. */
  innSpawn: Vec2;
}

export interface CampDef {
  id: number;
  cx: number;
  cy: number;
  radius: number;
  monster: MonsterId;
  count: number;
}

export interface PortalDef {
  id: number;
  name: string;
  tx: number;
  ty: number;
  /** Base difficulty of floor 0. */
  level: number;
}

export interface RoadDef {
  a: number; // village ids
  b: number;
  /** Waypoints in WORLD coordinates, for caravans to follow. */
  points: Vec2[];
}

export interface OverworldData {
  map: TileMap;
  villages: VillageDef[];
  camps: CampDef[];
  portals: PortalDef[];
  roads: RoadDef[];
  /** Static torch positions in world coordinates (reactive light sources). */
  torches: Vec2[];
}

const VILLAGE_NAMES = [
  'Emberfall', 'Duskmere', 'Thornwick', 'Grimhollow', 'Ashford',
  'Ravenrest', 'Moorgate', 'Wolfden', 'Stonebrook', 'Fenwick',
];

const PORTAL_NAMES = [
  'Catacombs of Vhal', 'The Sunken Halls', 'Maw of Cinders', 'Barrow of Kings',
];

export const OVERWORLD_W = 176;
export const OVERWORLD_H = 176;

/**
 * Generate the overworld deterministically from a seed. Client and server both
 * call this; only the seed travels over the wire.
 */
export function generateOverworld(seed: number): OverworldData {
  const rng = new Rng(hashSeed(seed, 1));
  const map = new TileMap(OVERWORLD_W, OVERWORLD_H, Tile.Grass);
  const torches: Vec2[] = [];

  // --- border rock ring so nobody walks off the map
  for (let x = 0; x < map.w; x++) {
    for (let y = 0; y < map.h; y++) {
      if (x < 2 || y < 2 || x >= map.w - 2 || y >= map.h - 2) map.set(x, y, Tile.Rock);
    }
  }

  // --- scatter terrain features: forests, rock outcrops, ponds
  scatterBlobs(rng, map, Tile.Tree, 90, 2, 5);
  scatterBlobs(rng, map, Tile.Rock, 25, 1, 3);
  scatterBlobs(rng, map, Tile.Water, 14, 2, 4);

  // --- villages, spread apart
  const villages: VillageDef[] = [];
  const villageCount = 4;
  const spots = pickSpreadPoints(rng, map, villageCount, 55, 24);
  for (let i = 0; i < spots.length; i++) {
    villages.push(buildVillage(rng, map, torches, i, spots[i].x, spots[i].y));
  }

  // --- roads: chain villages, then one extra loop connection
  const roads: RoadDef[] = [];
  for (let i = 1; i < villages.length; i++) {
    roads.push(carveRoad(rng, map, villages[i - 1], villages[i]));
  }
  if (villages.length > 2) {
    roads.push(carveRoad(rng, map, villages[villages.length - 1], villages[0]));
  }

  // --- monster camps: away from villages
  const camps: CampDef[] = [];
  const campMonsters: MonsterId[] = ['goblin', 'goblin', 'wolf', 'wolf', 'orc', 'orc', 'goblin', 'orc'];
  const campSpots = pickSpreadPoints(rng, map, campMonsters.length, 20, 10, (x, y) =>
    villages.every((v) => dist(x, y, v.cx, v.cy) > v.radius + 14)
  );
  for (let i = 0; i < campSpots.length; i++) {
    const radius = rng.int(4, 6);
    clearArea(map, campSpots[i].x, campSpots[i].y, radius);
    const c = tileCenter(campSpots[i].x, campSpots[i].y);
    torches.push(c); // camp fire
    camps.push({
      id: i,
      cx: campSpots[i].x,
      cy: campSpots[i].y,
      radius,
      monster: campMonsters[i],
      count: rng.int(4, 6),
    });
  }

  // --- dungeon portals
  const portals: PortalDef[] = [];
  const portalSpots = pickSpreadPoints(rng, map, PORTAL_NAMES.length, 40, 12, (x, y) =>
    villages.every((v) => dist(x, y, v.cx, v.cy) > v.radius + 8) &&
    camps.every((c) => dist(x, y, c.cx, c.cy) > c.radius + 6)
  );
  for (let i = 0; i < portalSpots.length; i++) {
    const { x, y } = portalSpots[i];
    clearArea(map, x, y, 3);
    map.set(x, y, Tile.PortalPad);
    const c = tileCenter(x, y);
    torches.push({ x: c.x - 3, y: c.y - 3 });
    torches.push({ x: c.x + 3, y: c.y - 3 });
    portals.push({ id: i, name: PORTAL_NAMES[i], tx: x, ty: y, level: 2 + i * 3 });
  }

  return { map, villages, camps, portals, roads, torches };
}

function scatterBlobs(rng: Rng, map: TileMap, tile: Tile, count: number, rMin: number, rMax: number) {
  for (let i = 0; i < count; i++) {
    const cx = rng.int(6, map.w - 7);
    const cy = rng.int(6, map.h - 7);
    const r = rng.int(rMin, rMax);
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (dist(x, y, cx, cy) <= r && rng.chance(0.75) && map.get(x, y) === Tile.Grass) {
          map.set(x, y, tile);
        }
      }
    }
  }
}

function pickSpreadPoints(
  rng: Rng,
  map: TileMap,
  count: number,
  minDist: number,
  margin: number,
  extraOk?: (x: number, y: number) => boolean
): Vec2[] {
  const points: Vec2[] = [];
  let attempts = 0;
  while (points.length < count && attempts < 4000) {
    attempts++;
    const x = rng.int(margin, map.w - margin);
    const y = rng.int(margin, map.h - margin);
    if (points.some((p) => dist(p.x, p.y, x, y) < minDist)) continue;
    if (extraOk && !extraOk(x, y)) continue;
    points.push({ x, y });
  }
  return points;
}

function clearArea(map: TileMap, cx: number, cy: number, r: number, to: Tile = Tile.Grass) {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (map.inBounds(x, y) && dist(x, y, cx, cy) <= r + 0.5) map.set(x, y, to);
    }
  }
}

function buildVillage(
  rng: Rng,
  map: TileMap,
  torches: Vec2[],
  id: number,
  cx: number,
  cy: number
): VillageDef {
  const radius = 11;
  clearArea(map, cx, cy, radius);
  const houses: HouseDef[] = [];

  // The inn: a large house near the center. Its interior is the respawn point.
  const inn = placeHouse(rng, map, cx - 4, cy - 5, 8, 6, true);
  houses.push(inn);

  // Smaller houses on a ring around the center.
  const houseCount = rng.int(3, 5);
  for (let i = 0; i < houseCount; i++) {
    const ang = (i / houseCount) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const hx = Math.round(cx + Math.cos(ang) * (radius - 4)) - 2;
    const hy = Math.round(cy + Math.sin(ang) * (radius - 4)) - 2;
    const w = rng.int(4, 5);
    const h = rng.int(4, 5);
    if (rectOverlapsAny(hx, hy, w, h, houses)) continue;
    houses.push(placeHouse(rng, map, hx, hy, w, h, false));
  }

  // Torches: village square + one at each door.
  const center = tileCenter(cx, cy);
  torches.push(center);
  for (const h of houses) {
    const d = tileCenter(h.door.x, h.door.y);
    torches.push({ x: d.x, y: d.y + 1.2 });
  }

  const innSpawn = tileCenter(inn.x + Math.floor(inn.w / 2), inn.y + Math.floor(inn.h / 2));
  return { id, name: VILLAGE_NAMES[id % VILLAGE_NAMES.length], cx, cy, radius, houses, innSpawn };
}

function rectOverlapsAny(x: number, y: number, w: number, h: number, houses: HouseDef[]): boolean {
  return houses.some(
    (o) => x < o.x + o.w + 1 && x + w + 1 > o.x && y < o.y + o.h + 1 && y + h + 1 > o.y
  );
}

function placeHouse(rng: Rng, map: TileMap, x: number, y: number, w: number, h: number, isInn: boolean): HouseDef {
  for (let tx = x; tx < x + w; tx++) {
    for (let ty = y; ty < y + h; ty++) {
      const border = tx === x || ty === y || tx === x + w - 1 || ty === y + h - 1;
      map.set(tx, ty, border ? Tile.Wall : Tile.Floor);
    }
  }
  // Door on the south wall.
  const doorX = x + rng.int(1, w - 2);
  const door = { x: doorX, y: y + h - 1 };
  map.set(door.x, door.y, Tile.Door);
  return { x, y, w, h, door, isInn };
}

function carveRoad(rng: Rng, map: TileMap, a: VillageDef, b: VillageDef): RoadDef {
  const points: Vec2[] = [];
  let x = a.cx;
  let y = a.cy;
  points.push(tileCenter(x, y));
  let guard = 0;
  while ((x !== b.cx || y !== b.cy) && guard++ < 2000) {
    // Wander toward the target with slight jitter for organic roads.
    const dx = Math.sign(b.cx - x);
    const dy = Math.sign(b.cy - y);
    if (dx !== 0 && (dy === 0 || rng.chance(0.5))) x += dx;
    else if (dy !== 0) y += dy;
    carveRoadTile(map, x, y);
    if (guard % 6 === 0) points.push(tileCenter(x, y));
  }
  points.push(tileCenter(b.cx, b.cy));
  return { a: a.id, b: b.id, points };
}

function carveRoadTile(map: TileMap, x: number, y: number) {
  for (let ox = 0; ox <= 1; ox++) {
    for (let oy = 0; oy <= 1; oy++) {
      const t = map.get(x + ox, y + oy);
      // Roads plow through nature but never through buildings.
      if (t === Tile.Grass || t === Tile.Tree || t === Tile.Water || t === Tile.Rock) {
        map.set(x + ox, y + oy, Tile.Road);
      }
    }
  }
}
