import {
  DungeonFloorData,
  EntitySnapshot,
  INTERACT_RANGE,
  OverworldData,
  PLAYER_RADIUS,
  SelfState,
  SnapshotMsg,
  TileMap,
  ZoneMsg,
  dist,
  generateDungeonFloor,
  generateOverworld,
  moveWithCollision,
  terrainSpeedMul,
} from '@webmagic/shared';

/** How far behind server time remote entities are rendered (smooths 10 Hz snapshots). */
const INTERP_DELAY_MS = 130;
/** Max duration of one input chunk sent to the server. */
const CHUNK_MS = 50;

export interface InterpEntity {
  latest: EntitySnapshot;
  prevX: number;
  prevY: number;
  prevF: number;
  prevZ: number;
  prevT: number;
  nextX: number;
  nextY: number;
  nextF: number;
  nextZ: number;
  nextT: number;
}

interface PendingInput {
  seq: number;
  mx: number;
  my: number;
  dt: number; // seconds
  spdMul: number; // sprint/charge speed factor at the time (keeps replay exact)
}

export interface OutgoingInput {
  seq: number;
  mx: number;
  my: number;
  dt: number; // ms
  sprint: boolean;
}

/**
 * Client world model: the current zone (regenerated locally from the seed),
 * interpolated remote entities, and the predicted self position that is
 * reconciled against server acknowledgements.
 */
export class WorldState {
  zone: ZoneMsg | null = null;
  map: TileMap | null = null;
  overworld: OverworldData | null = null;
  dungeonFloor: DungeonFloorData | null = null;

  entities = new Map<number, InterpEntity>();
  self: SelfState | null = null;
  selfId = 0;
  x = 0;
  y = 0;
  worldTime = 0.5;

  private pending: PendingInput[] = [];
  private open: PendingInput | null = null;
  private seq = 0;
  private speed = 6.5;

  setZone(z: ZoneMsg): void {
    this.zone = z;
    this.entities.clear();
    this.pending = [];
    this.open = null;
    this.x = z.x;
    this.y = z.y;
    if (z.kind === 'overworld') {
      this.overworld = generateOverworld(z.seed);
      this.dungeonFloor = null;
      this.map = this.overworld.map;
    } else {
      this.dungeonFloor = generateDungeonFloor(z.seed, z.floor ?? 0);
      this.overworld = null;
      this.map = this.dungeonFloor.map;
    }
  }

  /**
   * Apply this frame's movement locally (instant response) and return a chunk
   * to transmit when one is complete.
   */
  move(mx: number, my: number, dtSec: number, spdMul = 1): OutgoingInput | null {
    dtSec = Math.min(dtSec, 0.06); // mirror the server's per-input clamp
    let flushed: OutgoingInput | null = null;
    const changed = this.open && (this.open.mx !== mx || this.open.my !== my || this.open.spdMul !== spdMul);
    if (this.open && (changed || this.open.dt + dtSec > CHUNK_MS / 1000)) {
      flushed = this.flush();
    }
    if (mx !== 0 || my !== 0) {
      if (!this.open) {
        this.open = { seq: ++this.seq, mx, my, dt: 0, spdMul };
      }
      this.open.dt += dtSec;
      this.applyMove(mx, my, dtSec, spdMul);
    }
    return flushed;
  }

  private flush(): OutgoingInput | null {
    if (!this.open) return null;
    const c = this.open;
    this.open = null;
    // server clamps dt to 60ms — mirror that so prediction stays exact
    c.dt = Math.min(c.dt, 0.06);
    this.pending.push(c);
    return { seq: c.seq, mx: c.mx, my: c.my, dt: Math.round(c.dt * 1000), sprint: c.spdMul > 1 };
  }

  private applyMove(mx: number, my: number, dtSec: number, spdMul: number): void {
    if (!this.map || this.self?.dead) return;
    // terrainSpeedMul mirrors the server exactly (wading is slow on both sides)
    const s = this.speed * spdMul * terrainSpeedMul(this.map, this.x, this.y);
    const res = moveWithCollision(this.map, this.x, this.y, mx * s * dtSec, my * s * dtSec, PLAYER_RADIUS);
    this.x = res.x;
    this.y = res.y;
  }

  applySnapshot(snap: SnapshotMsg, now: number): void {
    this.self = snap.self;
    this.speed = snap.self.spd;
    this.worldTime = snap.time;

    // --- reconcile prediction: rebase on the server's authoritative position
    // and replay inputs it has not processed yet.
    this.pending = this.pending.filter((p) => p.seq > snap.self.ack);
    let px = snap.self.x;
    let py = snap.self.y;
    if (this.map && !snap.self.dead) {
      for (const p of this.pending) {
        const s = this.speed * p.spdMul * terrainSpeedMul(this.map, px, py);
        const r = moveWithCollision(this.map, px, py, p.mx * s * p.dt, p.my * s * p.dt, PLAYER_RADIUS);
        px = r.x;
        py = r.y;
      }
      if (this.open) {
        const s = this.speed * this.open.spdMul * terrainSpeedMul(this.map, px, py);
        const r = moveWithCollision(this.map, px, py, this.open.mx * s * this.open.dt, this.open.my * s * this.open.dt, PLAYER_RADIUS);
        px = r.x;
        py = r.y;
      }
    }
    // Snap hard if wildly off (teleport), otherwise ease to hide micro-corrections.
    const err = dist(this.x, this.y, px, py);
    if (err > 2.5 || snap.self.dead) {
      this.x = px;
      this.y = py;
    } else if (err > 0.01) {
      this.x += (px - this.x) * 0.35;
      this.y += (py - this.y) * 0.35;
    }

    // --- remote entities: push into interpolation buffers
    for (const e of snap.ents) {
      const cur = this.entities.get(e.id);
      if (!cur) {
        this.entities.set(e.id, {
          latest: e,
          prevX: e.x, prevY: e.y, prevF: e.f, prevZ: e.z ?? 0, prevT: now,
          nextX: e.x, nextY: e.y, nextF: e.f, nextZ: e.z ?? 0, nextT: now,
        });
      } else {
        cur.prevX = cur.nextX;
        cur.prevY = cur.nextY;
        cur.prevF = cur.nextF;
        cur.prevZ = cur.nextZ;
        cur.prevT = cur.nextT;
        cur.nextX = e.x;
        cur.nextY = e.y;
        cur.nextF = e.f;
        cur.nextZ = e.z ?? 0;
        cur.nextT = now;
        cur.latest = e;
      }
    }
    for (const id of snap.gone) this.entities.delete(id);
  }

  /** Interpolated render position for a remote entity. */
  sample(e: InterpEntity, now: number): { x: number; y: number; f: number; z: number } {
    const t = now - INTERP_DELAY_MS;
    const span = e.nextT - e.prevT;
    if (span <= 0 || t >= e.nextT) return { x: e.nextX, y: e.nextY, f: e.nextF, z: e.nextZ };
    const a = Math.max(0, Math.min(1, (t - e.prevT) / span));
    let df = e.nextF - e.prevF;
    if (df > Math.PI) df -= Math.PI * 2;
    if (df < -Math.PI) df += Math.PI * 2;
    return {
      x: e.prevX + (e.nextX - e.prevX) * a,
      y: e.prevY + (e.nextY - e.prevY) * a,
      f: e.prevF + df * a,
      z: e.prevZ + (e.nextZ - e.prevZ) * a,
    };
  }

  /** Closest thing the player can press E on right now. */
  nearestInteractable(): InterpEntity | null {
    let best: InterpEntity | null = null;
    let bestD = Infinity;
    for (const e of this.entities.values()) {
      const k = e.latest.k;
      const isTarget =
        k === 'portal' ||
        k === 'loot' ||
        (k === 'npc' && ['villager', 'signpost', 'campfire', 'chicken', 'shrine', 'obelisk'].includes(e.latest.v));
      if (!isTarget || e.latest.a === 'dead') continue;
      const d = dist(this.x, this.y, e.nextX, e.nextY);
      if (d < INTERACT_RANGE + 0.8 && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }
}
