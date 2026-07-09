import { Rng, hashSeed, makeNoise2D, Vec2, dist } from '../math';
import { Biome, Tile, TileMap, tileCenter } from '../tiles';
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
  /** The named region this camp lives in (wolf dens in their forest). */
  regionId?: number;
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

/** A decorative prop (barrel, crate, flowers…) in world coordinates. */
export interface PropDef {
  kind: 'barrel' | 'crate' | 'flowers' | 'haybale' | 'stall';
  x: number;
  y: number;
}

/** A wilderness landmark. World coordinates. */
export interface PoiDef {
  kind: 'shrine' | 'obelisk' | 'ruin';
  x: number;
  y: number;
  text?: string; // lore shown on interact (obelisks/shrines)
}

/**
 * A named region of the wilds — one connected sweep of forest, marsh,
 * highland or ashland, found by flood-filling the biome layer. Regions give
 * the world places (the life sim homes creatures in them, lore names them).
 * Tile coordinates.
 */
export interface RegionDef {
  id: number;
  kind: 'forest' | 'marsh' | 'highland' | 'ashland';
  name: string;
  /** Centroid tile. */
  cx: number;
  cy: number;
  /** Approximate radius in tiles (from area). */
  radius: number;
  /** Component size in tiles. */
  tiles: number;
}

export interface OverworldData {
  map: TileMap;
  villages: VillageDef[];
  camps: CampDef[];
  portals: PortalDef[];
  roads: RoadDef[];
  /** Static torch positions in world coordinates (reactive light sources). */
  torches: Vec2[];
  /** Decorative props that make settlements feel lived-in. */
  props: PropDef[];
  /** Wilderness landmarks — shrines, obelisks, ruins. */
  pois: PoiDef[];
  /** Named biome regions — forests, fens, highlands, ashlands. */
  regions: RegionDef[];
}

const VILLAGE_NAMES = [
  'Emberfall', 'Duskmere', 'Thornwick', 'Grimhollow', 'Ashford',
  'Ravenrest', 'Moorgate', 'Wolfden', 'Stonebrook', 'Fenwick',
];

const PORTAL_NAMES = [
  'Catacombs of Vhal', 'The Sunken Halls', 'Maw of Cinders', 'Barrow of Kings',
];

const FOREST_NAMES = [
  'The Gloomwood', 'The Whisperwood', 'Tanglewood', 'The Murkwald',
  'Hollowpine Forest', 'Wolfwood', 'The Blackboughs', 'Thornshade',
];
const MARSH_NAMES = [
  'The Sallow Fen', 'Mirebog', 'The Drowned Meadow', 'Rotmarsh', 'The Weeping Flats',
];
const HIGHLAND_NAMES = [
  'The Grey Tors', 'Windscar Heights', 'Cragfell', 'The Old Shoulders', 'The Bleak Steps',
];
const ASHLAND_NAMES = [
  'The Cinderwaste', 'Ashenfield', 'The Scorch', 'Emberreach',
];

export const OVERWORLD_W = 288;
export const OVERWORLD_H = 288;

const OBELISK_LORE = [
  'Weathered runes: "Here the first lantern was lit against the long dark."',
  'The stone reads: "Traveler — the deep remembers every name it takes."',
  'Faint carving: "Six villages, one vigil. Keep the roads."',
  'Ancient script: "When the sky tears, stand fast and do not look within."',
];
const SHRINE_LINES = [
  'You kneel at the shrine. Warmth spreads through your limbs.',
  'The shrine glows softly. Your wounds close and your spirit lifts.',
  'A calm settles over you as the shrine answers your prayer.',
];

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

  // --- biome pass: moisture and relief noise carve the world into regions
  // with real character — deep forests, sodden fens, rocky highlands and
  // scorched ashlands — instead of one endless grassland.
  const moist = makeNoise2D(hashSeed(seed, 11), 24);
  const moist2 = makeNoise2D(hashSeed(seed, 12), 48);
  const relief = makeNoise2D(hashSeed(seed, 13), 24);
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const m = moist(tx / 44, ty / 44) * 0.85 + moist2(tx / 15, ty / 15) * 0.15;
      const rl = relief(tx / 48, ty / 48);
      let b = Biome.Meadow;
      if (rl > 0.72) b = Biome.Highland;
      else if (m > 0.72) b = Biome.Marsh;
      else if (m > 0.47) b = Biome.Forest;
      else if (m < 0.17) b = Biome.Ashland;
      map.setBiome(tx, ty, b);
    }
  }

  // --- biome features: each region grows what belongs there
  const clump = makeNoise2D(hashSeed(seed, 14), 40);
  const pool = makeNoise2D(hashSeed(seed, 15), 32);
  for (let ty = 2; ty < map.h - 2; ty++) {
    for (let tx = 2; tx < map.w - 2; tx++) {
      if (map.get(tx, ty) !== Tile.Grass) continue;
      switch (map.biomeAt(tx, ty)) {
        case Biome.Forest:
          // dense woods with organic clearings — roads are carved through later
          if (clump(tx / 3.2, ty / 3.2) > 0.42) map.set(tx, ty, Tile.Tree);
          break;
        case Biome.Marsh:
          // still black pools threaded with dry ground
          if (pool(tx / 4.5, ty / 4.5) > 0.64) map.set(tx, ty, Tile.Water);
          else if (clump(tx / 2.5, ty / 2.5) > 0.78) map.set(tx, ty, Tile.Tree); // gnarled fen trees
          break;
        case Biome.Highland:
          if (clump(tx / 3.5, ty / 3.5) > 0.72) map.set(tx, ty, Tile.Rock);
          break;
        case Biome.Ashland:
          // sparse dead snags and cinder boulders
          if (clump(tx / 2.2, ty / 2.2) > 0.84) map.set(tx, ty, Tile.Tree);
          else if (pool(tx / 2.8, ty / 2.8) > 0.9) map.set(tx, ty, Tile.Rock);
          break;
      }
    }
  }

  // meadow copses, outcrops and ponds — sparser now that forests are biome-grown
  scatterBlobs(rng, map, Tile.Tree, 70, 2, 5);
  scatterBlobs(rng, map, Tile.Rock, 30, 1, 3);
  scatterBlobs(rng, map, Tile.Water, 18, 2, 5);

  // --- named regions: connected biome sweeps become places with names
  const regions = extractRegions(map);

  // --- villages: on open meadow, spread apart
  const villages: VillageDef[] = [];
  const villageCount = 6;
  const spots = pickSpreadPoints(rng, map, villageCount, 50, 26, (x, y) =>
    map.biomeAt(x, y) === Biome.Meadow
  );
  for (let i = 0; i < spots.length; i++) {
    villages.push(buildVillage(rng, map, torches, i, spots[i].x, spots[i].y));
    // settlements tame the land around them
    clearBiome(map, spots[i].x, spots[i].y, 13, Biome.Meadow);
  }

  // --- roads: chain villages, then one extra loop connection
  const roads: RoadDef[] = [];
  for (let i = 1; i < villages.length; i++) {
    roads.push(carveRoad(rng, map, villages[i - 1], villages[i]));
  }
  if (villages.length > 2) {
    roads.push(carveRoad(rng, map, villages[villages.length - 1], villages[0]));
  }

  // --- monster camps: goblin and orc war-camps on open ground; wolf dens
  // hidden deep inside the named forests (the packs live there — hunger is
  // what draws them out into the open world).
  const camps: CampDef[] = [];
  const campMonsters: MonsterId[] = ['goblin', 'goblin', 'goblin', 'orc', 'orc', 'orc', 'goblin', 'orc'];
  const campSpots = pickSpreadPoints(rng, map, campMonsters.length, 20, 10, (x, y) =>
    villages.every((v) => dist(x, y, v.cx, v.cy) > v.radius + 14) &&
    map.biomeAt(x, y) !== Biome.Marsh
  );
  for (let i = 0; i < campSpots.length; i++) {
    const radius = rng.int(4, 6);
    clearArea(map, campSpots[i].x, campSpots[i].y, radius);
    const c = tileCenter(campSpots[i].x, campSpots[i].y);
    torches.push(c); // camp fire
    camps.push({
      id: camps.length,
      cx: campSpots[i].x,
      cy: campSpots[i].y,
      radius,
      monster: campMonsters[i],
      count: rng.int(4, 6),
    });
  }

  // wolf dens: one per sizeable forest, biggest woods first (wolves light no fires)
  const forests = regions.filter((r) => r.kind === 'forest').sort((a, b) => b.tiles - a.tiles);
  for (const forest of forests.slice(0, 4)) {
    let den: Vec2 | null = null;
    for (let tries = 0; tries < 30; tries++) {
      const x = Math.round(forest.cx + rng.range(-forest.radius * 0.5, forest.radius * 0.5));
      const y = Math.round(forest.cy + rng.range(-forest.radius * 0.5, forest.radius * 0.5));
      if (!map.inBounds(x, y) || map.biomeAt(x, y) !== Biome.Forest) continue;
      if (villages.some((v) => dist(x, y, v.cx, v.cy) < v.radius + 12)) continue;
      den = { x, y };
      break;
    }
    if (!den) continue;
    const radius = rng.int(3, 4);
    clearArea(map, den.x, den.y, radius);
    camps.push({
      id: camps.length,
      cx: den.x,
      cy: den.y,
      radius,
      monster: 'wolf',
      count: rng.int(3, 5),
      regionId: forest.id,
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

  // --- wilderness landmarks: shrines, obelisks and ruins, out in the wilds
  // away from villages/camps/portals. These give the overworld destinations.
  const pois: PoiDef[] = [];
  const poiKinds: PoiDef['kind'][] = ['shrine', 'shrine', 'shrine', 'obelisk', 'obelisk', 'obelisk', 'ruin', 'ruin', 'ruin'];
  const poiSpots = pickSpreadPoints(rng, map, poiKinds.length, 30, 12, (x, y) =>
    villages.every((v) => dist(x, y, v.cx, v.cy) > v.radius + 10) &&
    camps.every((c) => dist(x, y, c.cx, c.cy) > c.radius + 8) &&
    portals.every((p) => dist(x, y, p.tx, p.ty) > 12)
  );
  let obeliskN = 0;
  let shrineN = 0;
  for (let i = 0; i < poiSpots.length; i++) {
    const { x, y } = poiSpots[i];
    const kind = poiKinds[i];
    const c = tileCenter(x, y);
    if (kind === 'ruin') {
      // A ruined structure: broken walls around a cleared floor, with a torch.
      clearArea(map, x, y, 4, Tile.Floor);
      carveRuinWalls(rng, map, x, y);
      torches.push(c);
      pois.push({ kind, x: c.x, y: c.y });
    } else if (kind === 'obelisk') {
      clearArea(map, x, y, 2);
      torches.push(c);
      pois.push({ kind, x: c.x, y: c.y, text: OBELISK_LORE[obeliskN++ % OBELISK_LORE.length] });
    } else {
      clearArea(map, x, y, 2);
      torches.push(c);
      pois.push({ kind, x: c.x, y: c.y, text: SHRINE_LINES[shrineN++ % SHRINE_LINES.length] });
    }
  }

  // --- terrain elevation: rolling hills across the wilds, flattened around
  // settlements, roads and portals so gameplay spaces stay level. Biomes
  // shape the relief: highlands rise, fens lie dead flat, ashlands smoulder low.
  const hn = makeNoise2D(hashSeed(seed, 7), 20);
  const hn2 = makeNoise2D(hashSeed(seed, 8), 40);
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const n = hn(tx / 11, ty / 11) * 0.7 + hn2(tx / 5, ty / 5) * 0.3;
      let lvl = Math.round(Math.pow(n, 1.4) * 5); // 0..5 levels
      switch (map.biomeAt(tx, ty)) {
        case Biome.Highland:
          lvl = Math.min(8, lvl + 2 + Math.round(hn2(tx / 7, ty / 7) * 2));
          break;
        case Biome.Marsh:
          lvl = 0;
          break;
        case Biome.Ashland:
          lvl = Math.round(lvl * 0.5);
          break;
      }
      map.setHeight(tx, ty, lvl);
      if (map.get(tx, ty) === Tile.Road) map.setHeight(tx, ty, 0);
    }
  }
  const flatten = (cx: number, cy: number, radius: number) => {
    for (let ty = Math.floor(cy - radius); ty <= cy + radius; ty++) {
      for (let tx = Math.floor(cx - radius); tx <= cx + radius; tx++) {
        if (dist(tx, ty, cx, cy) <= radius) map.setHeight(tx, ty, 0);
      }
    }
  };
  for (const v of villages) flatten(v.cx, v.cy, v.radius + 5);
  for (const p of portals) flatten(p.tx, p.ty, 6);
  for (const poi of pois) flatten(poi.x / 2 - 0.5, poi.y / 2 - 0.5, poi.kind === 'ruin' ? 5 : 3);

  // --- decorative props scattered around each village to make it lived-in
  const props: PropDef[] = [];
  const propKinds: PropDef['kind'][] = ['barrel', 'crate', 'flowers', 'flowers', 'haybale', 'stall'];
  for (const v of villages) {
    const count = 10 + rng.int(0, 6);
    for (let i = 0; i < count; i++) {
      const ang = rng.next() * Math.PI * 2;
      const r = rng.range(3, v.radius - 1);
      const tx = Math.round(v.cx + Math.cos(ang) * r);
      const ty = Math.round(v.cy + Math.sin(ang) * r);
      const t = map.get(tx, ty);
      if (t !== Tile.Grass && t !== Tile.Road) continue; // only on open ground
      props.push({ kind: rng.pick(propKinds), x: (tx + 0.5) * 2, y: (ty + 0.5) * 2 });
    }
  }

  return { map, villages, camps, portals, roads, torches, props, pois, regions };
}

/**
 * Flood-fill the biome layer into connected components; sweeps big enough to
 * matter become named regions. Deterministic: scan order and name pools are
 * fixed, so client and server agree on every name.
 */
function extractRegions(map: TileMap): RegionDef[] {
  const kindOf = (b: Biome): RegionDef['kind'] | null =>
    b === Biome.Forest ? 'forest'
    : b === Biome.Marsh ? 'marsh'
    : b === Biome.Highland ? 'highland'
    : b === Biome.Ashland ? 'ashland'
    : null;
  // Only sweeps big enough to be *places* get a name — smaller patches remain
  // anonymous terrain texture.
  const MIN_TILES: Record<RegionDef['kind'], number> = { forest: 240, marsh: 160, highland: 240, ashland: 180 };
  const NAME_POOLS: Record<RegionDef['kind'], string[]> = {
    forest: FOREST_NAMES,
    marsh: MARSH_NAMES,
    highland: HIGHLAND_NAMES,
    ashland: ASHLAND_NAMES,
  };
  const counters: Record<RegionDef['kind'], number> = { forest: 0, marsh: 0, highland: 0, ashland: 0 };

  const visited = new Uint8Array(map.w * map.h);
  const regions: RegionDef[] = [];
  const stack: number[] = [];
  for (let ty = 0; ty < map.h; ty++) {
    for (let tx = 0; tx < map.w; tx++) {
      const start = ty * map.w + tx;
      if (visited[start]) continue;
      visited[start] = 1;
      const b = map.biomeAt(tx, ty);
      const kind = kindOf(b);
      if (!kind) continue;

      let count = 0;
      let sx = 0;
      let sy = 0;
      stack.length = 0;
      stack.push(start);
      while (stack.length > 0) {
        const i = stack.pop()!;
        const ix = i % map.w;
        const iy = (i / map.w) | 0;
        count++;
        sx += ix;
        sy += iy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = ix + dx;
          const ny = iy + dy;
          if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
          const ni = ny * map.w + nx;
          if (visited[ni] || map.biomeAt(nx, ny) !== b) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }

      if (count < MIN_TILES[kind]) continue;
      const pool = NAME_POOLS[kind];
      regions.push({
        id: regions.length,
        kind,
        name: pool[counters[kind]++ % pool.length],
        cx: Math.round(sx / count),
        cy: Math.round(sy / count),
        radius: Math.max(4, Math.round(Math.sqrt(count / Math.PI))),
        tiles: count,
      });
    }
  }
  return regions;
}

/** Repaint the biome layer in a disc (settlements tame the wilds around them). */
function clearBiome(map: TileMap, cx: number, cy: number, r: number, to: Biome): void {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (map.inBounds(x, y) && dist(x, y, cx, cy) <= r + 0.5) map.setBiome(x, y, to);
    }
  }
}

/** Carve a rough ring of broken wall tiles around a ruin center. */
function carveRuinWalls(rng: Rng, map: TileMap, cx: number, cy: number) {
  const r = 4;
  for (let a = 0; a < Math.PI * 2; a += 0.18) {
    if (rng.chance(0.35)) continue; // gaps = "broken"
    const tx = Math.round(cx + Math.cos(a) * r);
    const ty = Math.round(cy + Math.sin(a) * r);
    if (map.inBounds(tx, ty) && map.get(tx, ty) === Tile.Floor) map.set(tx, ty, Tile.Wall);
  }
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
