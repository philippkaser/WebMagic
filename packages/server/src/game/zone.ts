import {
  FxMsg,
  TileMap,
  Vec2,
  moveWithCollision,
} from '@webmagic/shared';
import { Entity } from './entities';
import { SpatialGrid } from './spatial';
import type { Player } from './player';

/**
 * Callbacks a zone uses to talk to the rest of the server without owning it.
 * GameServer implements this; tests can stub it.
 */
export interface ZoneHost {
  now(): number;
  broadcastFx(zone: Zone, fx: FxMsg): void;
  onEntityKilled(zone: Zone, victim: Entity, killer: Entity | null): void;
  playerByEntityId(id: number): Player | undefined;
}

export type ZoneKind = 'overworld' | 'dungeon';

/**
 * A zone is one independently simulated space: the overworld, or a single
 * dungeon floor. Zones own their entities and spatial index. They know
 * nothing about sockets — replication happens in GameServer.
 *
 * Scaling note: because zones are self-contained, they are the natural unit
 * for sharding across worker threads or processes later.
 */
export class Zone {
  readonly id: string;
  readonly kind: ZoneKind;
  readonly map: TileMap;
  readonly grid = new SpatialGrid();
  readonly entities = new Map<number, Entity>();
  readonly players = new Set<Player>();
  readonly torches: Vec2[];

  private regenAcc = 0;

  constructor(id: string, kind: ZoneKind, map: TileMap, torches: Vec2[]) {
    this.id = id;
    this.kind = kind;
    this.map = map;
    this.torches = torches;
  }

  addEntity(e: Entity): void {
    this.entities.set(e.id, e);
    this.grid.insert(e);
  }

  removeEntity(e: Entity): void {
    this.entities.delete(e.id);
    this.grid.remove(e);
  }

  /** Collision-resolved movement; keeps the spatial index in sync. */
  moveEntity(e: Entity, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const res = moveWithCollision(this.map, e.x, e.y, dx, dy, e.radius);
    e.x = res.x;
    e.y = res.y;
    this.grid.update(e);
  }

  tick(host: ZoneHost, dt: number): void {
    const now = host.now();
    this.tickProjectiles(host, dt, now);
    this.tickLifetimes(now);
    this.tickRegen(dt);
  }

  private tickProjectiles(host: ZoneHost, dt: number, now: number): void {
    for (const e of [...this.entities.values()]) {
      if (e.kind !== 'projectile') continue;
      e.ttl! -= dt;
      if (e.ttl! <= 0) {
        this.removeEntity(e);
        continue;
      }
      const nx = e.x + e.vx! * dt;
      const ny = e.y + e.vy! * dt;
      if (this.map.blockedAtWorld(nx, ny)) {
        this.removeEntity(e);
        continue;
      }
      e.x = nx;
      e.y = ny;
      this.grid.update(e);

      // hit detection
      const near = this.grid.query(e.x, e.y, 1.2);
      for (const target of near) {
        if (target.dead || target.id === e.ownerId) continue;
        if (target.kind !== 'player' && target.kind !== 'monster' && target.kind !== 'npc') continue;
        if (target.faction === e.faction) continue;
        const dx = target.x - e.x;
        const dy = target.y - e.y;
        const r = target.radius + e.radius;
        if (dx * dx + dy * dy > r * r) continue;
        const owner = this.entities.get(e.ownerId ?? -1) ?? null;
        this.applyDamage(host, target, e.damage ?? 1, owner, now);
        if (e.slowMs && !target.dead) target.slowUntil = now + e.slowMs;
        this.removeEntity(e);
        break;
      }
    }
  }

  private tickLifetimes(now: number): void {
    for (const e of [...this.entities.values()]) {
      if (e.despawnAt && now >= e.despawnAt) this.removeEntity(e);
    }
  }

  private tickRegen(dt: number): void {
    this.regenAcc += dt;
    if (this.regenAcc < 1) return;
    const step = this.regenAcc;
    this.regenAcc = 0;
    for (const p of this.players) {
      if (p.entity.dead) continue;
      p.entity.hp = Math.min(p.stats.maxHp, p.entity.hp + p.stats.hpRegen * step);
      p.mp = Math.min(p.stats.maxMp, p.mp + p.stats.mpRegen * step);
    }
  }

  /** Central damage funnel: armor, kill handling, fx. */
  applyDamage(host: ZoneHost, target: Entity, raw: number, source: Entity | null, now: number): void {
    if (target.dead) return;
    let armor = 0;
    if (target.kind === 'player') {
      armor = host.playerByEntityId(target.id)?.stats.armor ?? 0;
    }
    const dmg = Math.max(1, Math.round(raw - armor * 0.5));
    target.hp -= dmg;
    if (source?.kind === 'player') target.lastHitBy = source.id;
    host.broadcastFx(this, {
      t: 'fx',
      kind: 'hit',
      x: target.x,
      y: target.y,
      entId: target.id,
      amount: dmg,
    });
    if (target.hp <= 0) {
      target.hp = 0;
      target.dead = true;
      target.anim = 'dead';
      host.onEntityKilled(this, target, source);
    } else if (target.ai && source && !target.ai.targetId && target.kind === 'monster') {
      // getting hit wakes monsters up
      target.ai.mode = 'chase';
      target.ai.targetId = source.id;
    }
  }

  heal(host: ZoneHost, target: Entity, amount: number): void {
    if (target.dead) return;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    host.broadcastFx(this, {
      t: 'fx',
      kind: 'heal',
      x: target.x,
      y: target.y,
      entId: target.id,
      amount: Math.round(amount),
    });
  }
}
