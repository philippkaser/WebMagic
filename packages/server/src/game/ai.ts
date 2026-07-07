import { MonsterDef, dist, hasLineOfSight } from '@webmagic/shared';
import { Entity } from './entities';
import { Zone, ZoneHost } from './zone';
import { spawnProjectile } from './combat';

export interface AiHost extends ZoneHost {
  onCaravanArrived(zone: Zone, caravan: Entity): void;
}

/** Combat profile for village guards (they reuse the monster stat shape). */
export const GUARD_COMBAT: MonsterDef = {
  id: 'goblin', // unused for guards
  name: 'Guard',
  level: 5,
  hp: 140,
  damage: 16,
  speed: 5.5,
  radius: 0.45,
  aggroRange: 12,
  attackRange: 1.8,
  attackCooldownMs: 1200,
  xp: 0,
  lootChance: 0,
  habitat: 'overworld',
};

const MONSTER_LEASH = 26;
const GUARD_LEASH = 24;

/**
 * Ticks every AI-driven entity in a zone. Target scans run at a staggered
 * ~300ms cadence (ai.nextThink); movement integrates every tick.
 */
export function tickAi(host: AiHost, zone: Zone, dt: number, monsterAggroMul: number): void {
  const now = host.now();
  for (const e of [...zone.entities.values()]) {
    if (!e.ai || e.dead) continue;
    if (e.stunUntil && now < e.stunUntil) {
      e.anim = 'idle';
      continue;
    }
    if (e.kind === 'monster') tickMonster(host, zone, e, dt, now, monsterAggroMul);
    else if (e.variant === 'guard') tickGuard(host, zone, e, dt, now);
    else if (e.variant === 'villager') tickVillager(zone, e, dt, now);
    else if (e.variant === 'caravan') tickCaravan(host, zone, e, dt, now);
    else if (e.variant === 'caravan-guard') tickCaravanGuard(host, zone, e, dt, now);
  }
}

function effectiveSpeed(e: Entity, now: number): number {
  return e.speed * (e.slowUntil && now < e.slowUntil ? 0.5 : 1);
}

function moveToward(zone: Zone, e: Entity, tx: number, ty: number, dt: number, now: number): void {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.05) {
    e.anim = 'idle';
    return;
  }
  const sp = effectiveSpeed(e, now);
  const step = Math.min(d, sp * dt);
  e.facing = Math.atan2(dy, dx);
  e.anim = 'move';
  zone.moveEntity(e, (dx / d) * step, (dy / d) * step);
}

function scanForTarget(zone: Zone, e: Entity, range: number, targetFaction: 'players' | 'monsters'): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const other of zone.grid.query(e.x, e.y, range)) {
    if (other.dead || other.faction !== targetFaction) continue;
    if (other.kind !== 'player' && other.kind !== 'monster' && other.kind !== 'npc') continue;
    const d = dist(e.x, e.y, other.x, other.y);
    if (d < bestD && hasLineOfSight(zone.map, e.x, e.y, other.x, other.y)) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

function tryAttack(host: AiHost, zone: Zone, e: Entity, target: Entity, def: MonsterDef, now: number): void {
  if (now < (e.attackCooldownUntil ?? 0)) return;
  e.attackCooldownUntil = now + def.attackCooldownMs;
  e.facing = Math.atan2(target.y - e.y, target.x - e.x);
  e.anim = 'attack';
  if (def.projectile) {
    spawnProjectile(zone, e, e.facing, {
      speed: def.projectile.speed,
      damage: def.damage,
      range: def.attackRange + 6,
      light: def.projectile.lightColor,
      variant: 'monster-bolt',
    });
  } else {
    zone.applyDamage(host, target, def.damage, e, now);
  }
}

function wanderOrIdle(zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  const target = ai.path?.[0];
  if (target && dist(e.x, e.y, target.x, target.y) > 0.6) {
    moveToward(zone, e, target.x, target.y, dt, now);
    return;
  }
  e.anim = 'idle';
  if (now >= ai.nextThink) {
    ai.nextThink = now + 1500 + Math.random() * 3500;
    if (Math.random() < 0.7) {
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * ai.wanderRadius;
      ai.path = [{ x: ai.home.x + Math.cos(ang) * r, y: ai.home.y + Math.sin(ang) * r }];
    }
  }
}

function validateTarget(zone: Zone, e: Entity, leash: number): Entity | null {
  const ai = e.ai!;
  if (!ai.targetId) return null;
  const target = zone.entities.get(ai.targetId);
  if (!target || target.dead || dist(e.x, e.y, ai.home.x, ai.home.y) > leash) {
    ai.targetId = undefined;
    ai.mode = 'return';
    return null;
  }
  return target;
}

function tickMonster(host: AiHost, zone: Zone, e: Entity, dt: number, now: number, aggroMul: number): void {
  const ai = e.ai!;
  const def = e.monsterDef!;
  let target = validateTarget(zone, e, MONSTER_LEASH);

  if (!target && now >= ai.nextThink) {
    ai.nextThink = now + 250 + Math.random() * 200;
    target = scanForTarget(zone, e, def.aggroRange * aggroMul, 'players');
    if (target) {
      ai.targetId = target.id;
      ai.mode = 'chase';
      ai.path = undefined;
    }
  }

  if (target) {
    const d = dist(e.x, e.y, target.x, target.y);
    if (d <= def.attackRange) {
      e.facing = Math.atan2(target.y - e.y, target.x - e.x);
      if (e.anim !== 'attack' || now >= (e.attackCooldownUntil ?? 0)) e.anim = 'idle';
      tryAttack(host, zone, e, target, def, now);
    } else {
      moveToward(zone, e, target.x, target.y, dt, now);
    }
    return;
  }

  if (ai.mode === 'return' && dist(e.x, e.y, ai.home.x, ai.home.y) > 2) {
    moveToward(zone, e, ai.home.x, ai.home.y, dt, now);
    return;
  }
  ai.mode = 'wander';
  wanderOrIdle(zone, e, dt, now);
}

function tickGuard(host: AiHost, zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  let target = validateTarget(zone, e, GUARD_LEASH);
  if (!target && now >= ai.nextThink) {
    ai.nextThink = now + 300 + Math.random() * 300;
    target = scanForTarget(zone, e, GUARD_COMBAT.aggroRange, 'monsters');
    if (target) {
      ai.targetId = target.id;
      ai.mode = 'chase';
    }
  }
  if (target) {
    const d = dist(e.x, e.y, target.x, target.y);
    if (d <= GUARD_COMBAT.attackRange) tryAttack(host, zone, e, target, GUARD_COMBAT, now);
    else moveToward(zone, e, target.x, target.y, dt, now);
    return;
  }
  if (ai.mode === 'return' && dist(e.x, e.y, ai.home.x, ai.home.y) > 2) {
    moveToward(zone, e, ai.home.x, ai.home.y, dt, now);
    return;
  }
  ai.mode = 'wander';
  wanderOrIdle(zone, e, dt, now);
}

function tickVillager(zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  // Flee from nearby monsters — guards will (hopefully) handle them.
  if (now >= ai.nextThink - 1200) {
    const threat = scanForTarget(zone, e, 7, 'monsters');
    if (threat) {
      const ang = Math.atan2(e.y - threat.y, e.x - threat.x);
      ai.path = [{ x: e.x + Math.cos(ang) * 8, y: e.y + Math.sin(ang) * 8 }];
      moveToward(zone, e, ai.path[0].x, ai.path[0].y, dt, now);
      return;
    }
  }
  wanderOrIdle(zone, e, dt, now);
}

function tickCaravan(host: AiHost, zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  const path = ai.path;
  if (!path || ai.pathIndex === undefined || ai.pathIndex >= path.length) {
    host.onCaravanArrived(zone, e);
    return;
  }
  const wp = path[ai.pathIndex];
  if (dist(e.x, e.y, wp.x, wp.y) < 1.6) {
    ai.pathIndex++;
    return;
  }
  moveToward(zone, e, wp.x, wp.y, dt, now);
}

function tickCaravanGuard(host: AiHost, zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  const leader = ai.escortId ? zone.entities.get(ai.escortId) : undefined;

  // Fight anything threatening the caravan.
  let target = ai.targetId ? zone.entities.get(ai.targetId) : undefined;
  if (target && (target.dead || (leader && dist(target.x, target.y, leader.x, leader.y) > 16))) {
    ai.targetId = undefined;
    target = undefined;
  }
  if (!target && now >= ai.nextThink) {
    ai.nextThink = now + 300 + Math.random() * 300;
    target = scanForTarget(zone, e, 10, 'monsters') ?? undefined;
    if (target) ai.targetId = target.id;
  }
  if (target) {
    const d = dist(e.x, e.y, target.x, target.y);
    if (d <= GUARD_COMBAT.attackRange) tryAttack(host, zone, e, target, GUARD_COMBAT, now);
    else moveToward(zone, e, target.x, target.y, dt, now);
    return;
  }

  if (!leader || leader.dead) {
    // Caravan gone: stand around sadly (despawn handled by worldSim).
    e.anim = 'idle';
    return;
  }
  if (dist(e.x, e.y, leader.x, leader.y) > 3.5) {
    moveToward(zone, e, leader.x + (Math.random() - 0.5) * 2, leader.y + (Math.random() - 0.5) * 2, dt, now);
  } else {
    e.anim = 'idle';
  }
}
