import { TILE_SIZE, TileMap } from './tiles';

/**
 * Move a circle through the tile map with axis-separated collision resolution.
 * Used by BOTH the server (authoritative movement) and the client (prediction),
 * so the two always agree.
 */
export function moveWithCollision(
  map: TileMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number
): { x: number; y: number } {
  let nx = resolveAxis(map, x + dx, y, radius, true, dx);
  let ny = resolveAxis(map, nx, y + dy, radius, false, dy);
  return { x: nx, y: ny };
}

function resolveAxis(
  map: TileMap,
  x: number,
  y: number,
  radius: number,
  horizontal: boolean,
  delta: number
): number {
  const minTx = Math.floor((x - radius) / TILE_SIZE);
  const maxTx = Math.floor((x + radius) / TILE_SIZE);
  const minTy = Math.floor((y - radius) / TILE_SIZE);
  const maxTy = Math.floor((y + radius) / TILE_SIZE);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!map.blockedTile(tx, ty)) continue;
      if (horizontal) {
        if (delta > 0) {
          const edge = tx * TILE_SIZE;
          if (x + radius > edge) x = edge - radius - 0.001;
        } else if (delta < 0) {
          const edge = (tx + 1) * TILE_SIZE;
          if (x - radius < edge) x = edge + radius + 0.001;
        }
      } else {
        if (delta > 0) {
          const edge = ty * TILE_SIZE;
          if (y + radius > edge) y = edge - radius - 0.001;
        } else if (delta < 0) {
          const edge = (ty + 1) * TILE_SIZE;
          if (y - radius < edge) y = edge + radius + 0.001;
        }
      }
    }
  }
  return horizontal ? x : y;
}

/** Line-of-sight check between two world points (DDA over blocking tiles). */
export function hasLineOfSight(map: TileMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const steps = Math.ceil((Math.abs(x1 - x0) + Math.abs(y1 - y0)) / (TILE_SIZE * 0.5)) + 1;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (map.blockedAtWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}
