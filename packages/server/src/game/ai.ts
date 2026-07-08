import { MonsterDef, Vec2, dist, hasLineOfSight } from '@webmagic/shared';
import { Entity, VillagerActivity, VillagerRoutine } from './entities';
import { Zone, ZoneHost } from './zone';
import { spawnProjectile } from './combat';

export interface AiHost extends ZoneHost {
  onCaravanArrived(zone: Zone, caravan: Entity): void;
  /** An NPC says something in local chat (heard by nearby players). */
  npcSay(zone: Zone, speaker: Entity, text: string): void;
}

/** The world clock as the AI sees it. Dungeons pass a neutral clock. */
export interface WorldClock {
  time: number; // 0..1, 0.5 = noon
  isNight: boolean;
  aggroMul: number;
}

const VILLAGER_DAY_LINES = [
  'Fine weather for honest work.',
  'The caravans keep us alive. Guard them if you can.',
  'They say the portals lead to halls full of treasure… and teeth.',
  'My grandfather built this house with his own hands.',
  'Heard wolves in the hills last night. Kept the candle burning.',
];
const VILLAGER_EVENING_LINES = [
  'Off to the inn — care for a mug?',
  'The innkeeper waters the ale, but don’t tell her I said so.',
  'A song and a fire, that’s all I need tonight.',
];
const VILLAGER_NIGHT_LINES = [
  'Time to lock the doors.',
  'Stay near the lanterns, stranger.',
  'Nothing good walks the roads at this hour.',
];
const GUARD_LINES = [
  'Move along. All’s quiet — for now.',
  'See anything green and ugly, you come find me.',
  'Third night this week the wolves have come close.',
  'Stay behind the torchline after dark.',
];

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
export function tickAi(host: AiHost, zone: Zone, dt: number, clock: WorldClock): void {
  const now = host.now();
  for (const e of [...zone.entities.values()]) {
    if (!e.ai || e.dead) continue;
    if (e.stunUntil && now < e.stunUntil) {
      e.anim = 'idle';
      continue;
    }
    if (e.kind === 'monster') tickMonster(host, zone, e, dt, now, clock);
    else if (e.variant === 'guard') tickGuard(host, zone, e, dt, now, clock);
    else if (e.variant === 'villager') tickVillager(host, zone, e, dt, now, clock);
    else if (e.variant === 'caravan') tickCaravan(host, zone, e, dt, now);
    else if (e.variant === 'caravan-guard') tickCaravanGuard(host, zone, e, dt, now);
  }
}

/** Any player within earshot? (used to skip flavor chatter into the void) */
function playersNearby(zone: Zone, e: Entity, range = 14): boolean {
  return zone.grid.query(e.x, e.y, range).some((o) => o.kind === 'player' && !o.dead);
}

function maybeSay(host: AiHost, zone: Zone, e: Entity, now: number, lines: string[]): void {
  const ai = e.ai!;
  if (ai.sayNext === undefined) ai.sayNext = now + 10_000 + Math.random() * 50_000;
  if (now < ai.sayNext) return;
  ai.sayNext = now + 45_000 + Math.random() * 75_000;
  if (!playersNearby(zone, e)) return;
  host.npcSay(zone, e, lines[Math.floor(Math.random() * lines.length)]);
}

/** Walk toward a waypoint; returns true when it was reached (or given up on). */
function walkWaypoint(zone: Zone, e: Entity, wp: Vec2, dt: number, now: number): boolean {
  if (dist(e.x, e.y, wp.x, wp.y) < 1.0) return true;
  // stuck detection: if we barely moved for a while, skip this waypoint
  const ai = e.ai!;
  if (!ai.stuckPos || dist(e.x, e.y, ai.stuckPos.x, ai.stuckPos.y) > 0.5) {
    ai.stuckPos = { x: e.x, y: e.y };
    ai.stuckSince = now;
  } else if (now - (ai.stuckSince ?? now) > 4000) {
    ai.stuckPos = undefined;
    return true;
  }
  moveToward(zone, e, wp.x, wp.y, dt, now);
  return false;
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
      explodeRadius: def.projectile.aoeRadius,
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

function tickMonster(host: AiHost, zone: Zone, e: Entity, dt: number, now: number, clock: WorldClock): void {
  const ai = e.ai!;
  const def = e.monsterDef!;
  let target = validateTarget(zone, e, MONSTER_LEASH);

  // Daily rhythm (overworld camps only): doze near the fire by day, prowl
  // wide at night. Nocturnal hunters barely react while the sun is up.
  let aggro = def.aggroRange * clock.aggroMul;
  if (e.campId !== undefined) {
    ai.wanderRadius = clock.isNight ? 13 : 5;
    if (def.nocturnal) aggro *= clock.isNight ? 1.25 : 0.35;
  }

  if (!target && now >= ai.nextThink) {
    ai.nextThink = now + 250 + Math.random() * 200;
    target = scanForTarget(zone, e, aggro, 'players');
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

function tickGuard(host: AiHost, zone: Zone, e: Entity, dt: number, now: number, clock: WorldClock): void {
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

  maybeSay(host, zone, e, now, GUARD_LINES);

  // Patrol duty: walk the circuit, pause at each post. Night shift pulls in
  // close to the torch-lit center; day shift walks the perimeter.
  const ring = (clock.isNight ? ai.patrolNight : ai.patrolDay) ?? ai.patrolDay;
  if (ring && ring.length > 0) {
    if (now < (ai.waitUntil ?? 0)) {
      e.anim = 'idle';
      return;
    }
    const wp = ring[(ai.patrolIndex ?? 0) % ring.length];
    if (walkWaypoint(zone, e, wp, dt, now)) {
      ai.patrolIndex = ((ai.patrolIndex ?? 0) + 1) % ring.length;
      ai.waitUntil = now + 1500 + Math.random() * 3500;
      e.anim = 'idle';
    }
    return;
  }
  wanderOrIdle(zone, e, dt, now);
}

function villagerActivityFor(time: number): VillagerActivity {
  if (time >= 0.26 && time < 0.68) return 'work';
  if (time >= 0.68 && time < 0.82) return 'inn';
  return 'home';
}

function tickVillager(host: AiHost, zone: Zone, e: Entity, dt: number, now: number, clock: WorldClock): void {
  const ai = e.ai!;
  // Danger overrides everything: run from monsters, guards will handle them.
  if (now >= ai.nextThink - 1200) {
    const threat = scanForTarget(zone, e, 7, 'monsters');
    if (threat) {
      const ang = Math.atan2(e.y - threat.y, e.x - threat.x);
      ai.routine && (ai.routine.commute = undefined);
      ai.chatUntil = undefined;
      moveToward(zone, e, e.x + Math.cos(ang) * 8, e.y + Math.sin(ang) * 8, dt, now);
      return;
    }
  }

  const r = ai.routine;
  if (r) {
    // --- schedule: work the day, drink in the evening, sleep at night
    const activity = villagerActivityFor(clock.time);
    if (r.activity !== activity) {
      r.activity = activity;
      r.commute = buildCommute(e, r, activity);
      ai.chatUntil = undefined;
    }
    if (r.commute && r.commute.length > 0) {
      if (walkWaypoint(zone, e, r.commute[0], dt, now)) r.commute.shift();
      else return;
    }
    // settled at the current stop
    const stop = r[activity];
    ai.home = { x: stop.x, y: stop.y };
    ai.wanderRadius = activity === 'work' ? 4.5 : 0.9;

    const lines =
      activity === 'work' ? VILLAGER_DAY_LINES : activity === 'inn' ? VILLAGER_EVENING_LINES : VILLAGER_NIGHT_LINES;
    maybeSay(host, zone, e, now, lines);

    // --- chatting: two idle villagers stop and face each other for a while
    if (ai.chatUntil && now < ai.chatUntil) {
      const partner = ai.chatPartnerId ? zone.entities.get(ai.chatPartnerId) : undefined;
      if (partner && !partner.dead) {
        e.facing = Math.atan2(partner.y - e.y, partner.x - e.x);
        e.anim = 'idle';
        return;
      }
      ai.chatUntil = undefined;
    }
    if (activity !== 'home' && now >= ai.nextThink && Math.random() < 0.25) {
      const other = zone.grid
        .query(e.x, e.y, 3.5)
        .find((o) => o !== e && o.variant === 'villager' && !o.dead && !(o.ai?.chatUntil && now < o.ai.chatUntil));
      if (other?.ai) {
        const until = now + 5000 + Math.random() * 8000;
        ai.chatUntil = until;
        ai.chatPartnerId = other.id;
        other.ai.chatUntil = until;
        other.ai.chatPartnerId = e.id;
      }
    }
  }
  wanderOrIdle(zone, e, dt, now);
}

/**
 * Waypoints for switching activities: leave the current building through its
 * door, and enter the destination building through its door — never through
 * a wall.
 */
function buildCommute(e: Entity, r: VillagerRoutine, activity: VillagerActivity): Vec2[] {
  const pts: Vec2[] = [];
  const target = r[activity];
  // step outside whatever building we are currently in
  for (const stop of [r.home, r.inn]) {
    if (stop !== target && stop.door && dist(e.x, e.y, stop.x, stop.y) < 4.5) {
      pts.push({ x: stop.door.x, y: stop.door.y });
      break;
    }
  }
  if (target.door) pts.push({ x: target.door.x, y: target.door.y });
  pts.push({ x: target.x, y: target.y });
  return pts;
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
