import type { Entity } from './entities';

/**
 * Uniform spatial hash grid for area-of-interest queries. Every zone owns one.
 * O(1) insert/move, O(cells) radius queries — this is what keeps per-player
 * replication cost independent of total world population.
 */
export class SpatialGrid {
  private readonly cellSize: number;
  private readonly cells = new Map<number, Set<Entity>>();

  constructor(cellSize = 16) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): number {
    return (cx & 0xffff) | ((cy & 0xffff) << 16);
  }

  private cellOf(x: number, y: number): number {
    return this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
  }

  insert(e: Entity): void {
    const k = this.cellOf(e.x, e.y);
    e._cell = k;
    let set = this.cells.get(k);
    if (!set) this.cells.set(k, (set = new Set()));
    set.add(e);
  }

  remove(e: Entity): void {
    if (e._cell === undefined) return;
    this.cells.get(e._cell)?.delete(e);
    e._cell = undefined;
  }

  /** Call after moving an entity. */
  update(e: Entity): void {
    const k = this.cellOf(e.x, e.y);
    if (k === e._cell) return;
    this.remove(e);
    e._cell = k;
    let set = this.cells.get(k);
    if (!set) this.cells.set(k, (set = new Set()));
    set.add(e);
  }

  /** All entities within `radius` of (x, y). */
  query(x: number, y: number, radius: number, out: Entity[] = []): Entity[] {
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    const r2 = radius * radius;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const set = this.cells.get(this.key(cx, cy));
        if (!set) continue;
        for (const e of set) {
          const dx = e.x - x;
          const dy = e.y - y;
          if (dx * dx + dy * dy <= r2) out.push(e);
        }
      }
    }
    return out;
  }
}
