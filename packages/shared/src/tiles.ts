/** World-space size of one tile, in meters. */
export const TILE_SIZE = 2;

/** Meters of elevation per height level (terrain verticality). */
export const HEIGHT_STEP = 0.7;

export enum Tile {
  Void = 0, // outside the map / unrendered
  Grass = 1,
  Road = 2,
  Tree = 3, // blocking, rendered as billboard
  Water = 4, // blocking
  Rock = 5, // blocking, rendered as wall block
  Floor = 6, // interior floor (houses, dungeon)
  Wall = 7, // blocking wall block
  Door = 8, // walkable doorway
  StairsDown = 9, // dungeon: descend to next floor
  PortalPad = 10, // decorative pad under portals
  Spikes = 11, // dungeon trap: hurts grounded players (jump over to cross safely)
}

/**
 * Regional character of the overworld. Biomes drive ground art, feature
 * density, creature habitats and region naming — a tile keeps its Tile type
 * (grass is walkable everywhere) while the biome says *which* wilds these are.
 */
export enum Biome {
  Meadow = 0, // open grassland — villages, roads, farmland
  Forest = 1, // deep dark woods — dense pines, wolves, deer
  Marsh = 2, // sodden fen — pools, mist, sickly reeds
  Highland = 3, // windswept rocky heights
  Ashland = 4, // scorched barrens — dead trees, cinders
}

const BLOCKING = new Set<Tile>([Tile.Void, Tile.Tree, Tile.Water, Tile.Rock, Tile.Wall]);

export function isBlocking(t: Tile): boolean {
  return BLOCKING.has(t);
}

/** Tiles rendered as full-height wall cubes. */
export function isWallLike(t: Tile): boolean {
  return t === Tile.Wall || t === Tile.Rock;
}

export class TileMap {
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  /** Per-tile terrain elevation, in height levels (see HEIGHT_STEP). */
  readonly heights: Uint8Array;
  /** Per-tile biome (see Biome). Dungeons leave this all-Meadow; unused there. */
  readonly biomes: Uint8Array;

  constructor(w: number, h: number, fill: Tile = Tile.Void) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h).fill(fill);
    this.heights = new Uint8Array(w * h);
    this.biomes = new Uint8Array(w * h);
  }

  biomeAt(tx: number, ty: number): Biome {
    if (!this.inBounds(tx, ty)) return Biome.Meadow;
    return this.biomes[ty * this.w + tx] as Biome;
  }

  setBiome(tx: number, ty: number, b: Biome): void {
    if (this.inBounds(tx, ty)) this.biomes[ty * this.w + tx] = b;
  }

  biomeAtWorld(x: number, y: number): Biome {
    return this.biomeAt(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
  }

  heightLevel(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 0;
    return this.heights[ty * this.w + tx];
  }

  setHeight(tx: number, ty: number, level: number): void {
    if (this.inBounds(tx, ty)) this.heights[ty * this.w + tx] = Math.max(0, Math.min(255, level));
  }

  /**
   * Smooth ground elevation in meters at a world position — bilinear over the
   * surrounding tile-centre heights, so flat areas stay flat and differing
   * neighbours become walkable inclines.
   */
  elevationAtWorld(x: number, y: number): number {
    const gx = x / TILE_SIZE - 0.5;
    const gy = y / TILE_SIZE - 0.5;
    const tx = Math.floor(gx);
    const ty = Math.floor(gy);
    const fx = gx - tx;
    const fy = gy - ty;
    const a = this.heightLevel(tx, ty);
    const b = this.heightLevel(tx + 1, ty);
    const c = this.heightLevel(tx, ty + 1);
    const d = this.heightLevel(tx + 1, ty + 1);
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return (top + (bot - top) * fy) * HEIGHT_STEP;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }

  get(tx: number, ty: number): Tile {
    if (!this.inBounds(tx, ty)) return Tile.Void;
    return this.tiles[ty * this.w + tx] as Tile;
  }

  set(tx: number, ty: number, t: Tile): void {
    if (this.inBounds(tx, ty)) this.tiles[ty * this.w + tx] = t;
  }

  /** Is the tile at world position (x, y) blocked? */
  blockedAtWorld(x: number, y: number): boolean {
    return isBlocking(this.get(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
  }

  blockedTile(tx: number, ty: number): boolean {
    return isBlocking(this.get(tx, ty));
  }
}

/** Center of a tile in world coordinates. */
export function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
}

export function worldToTile(v: number): number {
  return Math.floor(v / TILE_SIZE);
}
