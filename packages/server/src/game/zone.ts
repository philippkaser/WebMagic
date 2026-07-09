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
  /** Live projectiles only — keeps the per-tick flight pass off the full entity map. */
  readonly projectiles = new Set<Entity>();
  /** Entities currently being shoved by a knockback impulse. */
  private readonly impulsed = new Set<Entity>();

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
    if (e.kind === 'projectile') this.projectiles.add(e);
  }

  removeEntity(e: Entity): void {
    this.entities.delete(e.id);
    this.grid.remove(e);
    if (e.kind === 'projectile') this.projectiles.delete(e);
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
    this.tickImpulses(dt);
    this.tickLifetimes(now);
    this.tickRegen(dt);
  }

  /**
   * Shove an entity away from a point — the physical weight behind a hit.
   * Impulses decay fast; collision applies, so nothing is punched through walls.
   */
  impulse(target: Entity, fromX: number, fromY: number, strength: number): void {
    if (target.dead || target.speed === 0) return; // fixtures don't budge
    const dx = target.x - fromX;
    const dy = target.y - fromY;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    let kx = (target.kx ?? 0) + (dx / d) * strength;
    let ky = (target.ky ?? 0) + (dy / d) * strength;
    const mag = Math.sqrt(kx * kx + ky * ky);
    if (mag > 12) {
      kx = (kx / mag) * 12;
      ky = (ky / mag) * 12;
    }
    target.kx = kx;
    target.ky = ky;
    this.impulsed.add(target);
  }

  private tickImpulses(dt: number): void {
    for (const e of this.impulsed) {
      if (e.dead || !this.entities.has(e.id)) {
        this.impulsed.delete(e);
        continue;
      }
      this.moveEntity(e, e.kx! * dt, e.ky! * dt);
      const decay = Math.max(0, 1 - dt * 7);
      e.kx! *= decay;
      e.ky! *= decay;
      if (e.kx! * e.kx! + e.ky! * e.ky! < 0.05) {
        e.kx = 0;
        e.ky = 0;
        this.impulsed.delete(e);
      }
    }
  }

  private tickProjectiles(host: ZoneHost, dt: number, now: number): void {
    // Set iteration tolerates removal of the current element mid-loop.
    for (const e of this.projectiles) {
      e.ttl! -= dt;
      if (e.ttl! <= 0) {
        this.detonate(host, e, null, now); // fizzle at max range still pops
        continue;
      }
      const nx = e.x + e.vx! * dt;
      const ny = e.y + e.vy! * dt;
      if (this.map.blockedAtWorld(nx, ny)) {
        this.detonate(host, e, null, now); // wall impact
        continue;
      }
      e.x = nx;
      e.y = ny;
      this.grid.update(e);

      // hit detection — player bolts strike anything alive except their owner
      // (open PvP); monster bolts still pass through fellow monsters.
      const near = this.grid.query(e.x, e.y, 1.2);
      for (const target of near) {
        if (target.dead || target.id === e.ownerId) continue;
        if (target.kind !== 'player' && target.kind !== 'monster' && target.kind !== 'npc') continue;
        if (!this.projectileCanHit(e, target)) continue;
        const dx = target.x - e.x;
        const dy = target.y - e.y;
        const r = target.radius + e.radius;
        if (dx * dx + dy * dy > r * r) continue;
        this.detonate(host, e, target, now);
        break;
      }
    }
  }

  /**
   * PvP-aware projectile rules: player bolts hit anything alive except their
   * owner and fixtures; monster bolts spare fellow monsters and critters.
   */
  private projectileCanHit(proj: Entity, target: Entity): boolean {
    if (proj.faction === 'monsters') {
      return target.faction !== 'monsters' && target.faction !== 'none';
    }
    if (target.faction === 'none') {
      return target.variant === 'chicken' || target.variant === 'deer';
    }
    return true;
  }

  /**
   * End of a projectile's flight. Plain bolts damage only what they struck;
   * explosive ones (fireballs) blast everything hostile around the impact.
   */
  private detonate(host: ZoneHost, e: Entity, directTarget: Entity | null, now: number): void {
    this.removeEntity(e);
    const owner = this.entities.get(e.ownerId ?? -1) ?? null;
    const damage = e.damage ?? 1;

    if (!e.explodeRadius) {
      if (directTarget) {
        this.applyDamage(host, directTarget, damage, owner, now);
        if (e.slowMs && !directTarget.dead) directTarget.slowUntil = now + e.slowMs;
        // The bolt's momentum carries into the target.
        if (!directTarget.dead) this.impulse(directTarget, e.x - e.vx!, e.y - e.vy!, 2.5);
      }
      return;
    }

    host.broadcastFx(this, {
      t: 'fx',
      kind: 'explosion',
      x: e.x,
      y: e.y,
      color: e.light ?? 0xff7722,
      amount: e.explodeRadius,
    });
    for (const target of this.grid.query(e.x, e.y, e.explodeRadius)) {
      if (target.dead || target.id === e.ownerId) continue;
      if (target.kind !== 'player' && target.kind !== 'monster' && target.kind !== 'npc') continue;
      if (!this.projectileCanHit(e, target)) continue;
      // full damage on a direct hit, 70% for splash
      const dmg = target === directTarget ? damage : Math.max(1, Math.round(damage * 0.7));
      this.applyDamage(host, target, dmg, owner, now);
      if (e.slowMs && !target.dead) target.slowUntil = now + e.slowMs;
      // The blast wave throws everything caught in it outward.
      if (!target.dead) this.impulse(target, e.x, e.y, 7);
    }
  }

  private tickLifetimes(now: number): void {
    // Map iteration tolerates deletion of the current entry mid-loop.
    for (const e of this.entities.values()) {
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
    // Attacker's lifesteal heals them for a share of the damage dealt.
    if (source?.kind === 'player') {
      const attacker = host.playerByEntityId(source.id);
      if (attacker?.hasPassive('lifesteal') && !source.dead) {
        this.heal(host, source, dmg * 0.15);
      }
    }
    // Victim's thorns reflect a share back at a melee monster attacker.
    if (target.kind === 'player' && source && source.kind === 'monster' && !source.dead) {
      const victim = host.playerByEntityId(target.id);
      if (victim?.hasPassive('thorns')) {
        // source of the reflect is the player, so this can't recurse (monsters lack thorns).
        this.applyDamage(host, source, Math.max(1, dmg * 0.3), target, now);
      }
    }

    if (target.hp <= 0) {
      target.hp = 0;
      target.dead = true;
      target.anim = 'dead';
      host.onEntityKilled(this, target, source);
    } else {
      // Heavy hits stagger monsters — a beat of hit-stop that also cancels
      // any attack they were winding up. Rate-limited so fast weapons can't
      // stunlock a boss.
      if (
        target.kind === 'monster' &&
        dmg > target.maxHp * 0.18 &&
        now > (target.lastStaggerAt ?? 0) + 1000
      ) {
        target.lastStaggerAt = now;
        target.stunUntil = Math.max(target.stunUntil ?? 0, now + 160);
      }
      if (target.ai && source) {
        if (target.kind === 'monster' && !target.ai.targetId) {
          // getting hit wakes monsters up
          target.ai.mode = 'chase';
          target.ai.targetId = source.id;
        } else if (target.kind === 'npc') {
          if (target.monsterDef) {
            // guards and caravan guards fight back — whoever struck them
            target.ai.targetId = source.id;
            target.ai.mode = 'chase';
          } else if (target.faction === 'none') {
            // critters bolt from their attacker
            target.ai.targetId = source.id;
          } else {
            // civilians flee whoever hurt them
            target.ai.fleeFromId = source.id;
            target.ai.fleeUntil = now + 6000;
          }
        }
      }
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
