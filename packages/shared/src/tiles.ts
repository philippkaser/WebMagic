/** World-space size of one tile, in meters. */
export const TILE_SIZE = 2;

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

  constructor(w: number, h: number, fill: Tile = Tile.Void) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h).fill(fill);
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
