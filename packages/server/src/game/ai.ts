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
  windupMs: 340,
  xp: 0,
  lootChance: 0,
  habitat: 'overworld',
};

const MONSTER_LEASH = 26;
const GUARD_LEASH = 24;
/** Predator hunger: sated → starving in ~10 minutes of fruitless prowling. */
const HUNGER_PER_SEC = 1 / 600;

// --- simulation LOD ---------------------------------------------------------
// The living world only earns its keep near players. Entities beyond earshot
// of everyone think and move coarsely (~2.5 Hz over accumulated time) instead
// of every 50 ms — the ecosystem keeps living off-screen at a fraction of the
// cost, which is what lets a big world and a big player count coexist.
const LOD_FAR_DIST = 62;
const LOD_NEAR_DIST = 54; // hysteresis so entities don't flap between tiers
const FAR_TICK_MS = 380;
const FAR_MAX_STEP_SEC = 0.6;

function updateLod(e: Entity, watchers: Entity[], now: number): 'near' | 'far' {
  const ai = e.ai!;
  if (now >= (ai.lodCheckAt ?? 0)) {
    ai.lodCheckAt = now + 900 + Math.random() * 300;
    let best = Infinity;
    for (const w of watchers) {
      const dx = w.x - e.x;
      const dy = w.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    const threshold = ai.lod === 'far' ? LOD_NEAR_DIST : LOD_FAR_DIST;
    ai.lod = best <= threshold * threshold ? 'near' : 'far';
  }
  return ai.lod ?? 'near';
}

/**
 * Ticks every AI-driven entity in a zone. Target scans run at a staggered
 * ~300ms cadence (ai.nextThink); movement integrates every tick for near
 * entities and in coarse accumulated steps for far ones.
 */
export function tickAi(host: AiHost, zone: Zone, dt: number, clock: WorldClock): void {
  const now = host.now();
  const watchers: Entity[] = [];
  for (const p of zone.players) {
    if (!p.entity.dead) watchers.push(p.entity);
  }
  // Iterate the map directly (no per-tick copy). Removals mid-loop are safe;
  // entities spawned mid-loop may be visited this same tick, which is harmless.
  for (const e of zone.entities.values()) {
    const ai = e.ai;
    if (!ai || e.dead) continue;
    if (e.stunUntil && now < e.stunUntil) {
      e.anim = 'idle';
      // A stagger interrupts whatever attack was being wound up.
      e.windupUntil = undefined;
      e.windupTargetId = undefined;
      continue;
    }

    let effDt = dt;
    if (updateLod(e, watchers, now) === 'far') {
      ai.farAcc = (ai.farAcc ?? 0) + dt;
      if (now < (ai.farNext ?? 0)) continue;
      ai.farNext = now + FAR_TICK_MS;
      effDt = Math.min(ai.farAcc, FAR_MAX_STEP_SEC);
      ai.farAcc = 0;
    }

    if (e.kind === 'monster') tickMonster(host, zone, e, effDt, now, clock);
    else if (e.variant === 'guard') tickGuard(host, zone, e, effDt, now, clock);
    else if (e.variant === 'villager') tickVillager(host, zone, e, effDt, now, clock);
    else if (e.variant === 'caravan') tickCaravan(host, zone, e, effDt, now);
    else if (e.variant === 'caravan-guard') tickCaravanGuard(host, zone, e, effDt, now);
    else if (e.variant === 'chicken' || e.variant === 'deer') tickCritter(zone, e, effDt, now);
  }
}

/** Any player within earshot? (used to skip flavor chatter into the void) */
function playersNearby(zone: Zone, e: Entity, range = 14): boolean {
  return zone.grid.query(e.x, e.y, range).some((o) => o.kind === 'player' && !o.dead);
}

function maybeSay(host: AiHost, zone: Zone, e: Entity, now: number, lines: string[]): void {
  const ai = e.ai!;
  if (ai.lod === 'far') return; // nobody in earshot — skip the grid query too
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
  // Coarse LOD ticks can cover several meters at once — substep so collision
  // never tunnels through a wall thinner than the stride.
  let remaining = step;
  while (remaining > 0) {
    const s = Math.min(remaining, 0.9);
    zone.moveEntity(e, (dx / d) * s, (dy / d) * s);
    remaining -= s;
  }
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

/** Nearest live critter (chicken/deer) a predator could hunt. */
function scanForPrey(zone: Zone, e: Entity, range: number): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const other of zone.grid.query(e.x, e.y, range)) {
    if (other.dead || other.faction !== 'none') continue;
    if (other.variant !== 'chicken' && other.variant !== 'deer') continue;
    const d = dist(e.x, e.y, other.x, other.y);
    if (d < bestD && hasLineOfSight(zone.map, e.x, e.y, other.x, other.y)) {
      best = other;
      bestD = d;
    }
  }
  return best;
}

/**
 * Ambient critters (chickens, deer): peck and graze, but bolt from any
 * predator that wanders too close. Deer are skittish and flee players too.
 */
function tickCritter(zone: Zone, e: Entity, dt: number, now: number): void {
  const ai = e.ai!;
  const isDeer = e.variant === 'deer';
  const senseRange = isDeer ? 10 : 6;

  if (now >= ai.nextThink) {
    ai.nextThink = now + 250 + Math.random() * 250;
    let threat = scanForTarget(zone, e, senseRange, 'monsters');
    if (!threat && isDeer) threat = scanForTarget(zone, e, senseRange, 'players');
    ai.targetId = threat ? threat.id : undefined;
  }

  const threat = ai.targetId ? zone.entities.get(ai.targetId) : undefined;
  if (threat && !threat.dead && dist(e.x, e.y, threat.x, threat.y) < senseRange + 2) {
    // Sprint directly away from the threat.
    const ang = Math.atan2(e.y - threat.y, e.x - threat.x);
    const flee = e.speed;
    e.speed = flee * (isDeer ? 3.4 : 2.4); // panic burst
    moveToward(zone, e, e.x + Math.cos(ang) * 6, e.y + Math.sin(ang) * 6, dt, now);
    e.speed = flee;
    return;
  }
  ai.targetId = undefined;
  wanderOrIdle(zone, e, dt, now);
}

/**
 * Commit to an attack: the wind-up. The blow itself lands in resolveWindup
 * after def.windupMs — a telegraphed beat the target can dodge, and a window
 * in which a stagger cancels the attack outright.
 */
function tryAttack(host: AiHost, zone: Zone, e: Entity, target: Entity, def: MonsterDef, now: number): void {
  if (now < (e.attackCooldownUntil ?? 0) || e.windupUntil) return;
  const windup = def.windupMs ?? 400;
  e.windupUntil = now + windup;
  e.windupTargetId = target.id;
  e.facing = Math.atan2(target.y - e.y, target.x - e.x);
  e.anim = 'attack';
  host.broadcastFx(zone, { t: 'fx', kind: 'windup', x: e.x, y: e.y, entId: e.id, amount: windup });
}

/**
 * Advance an in-flight wind-up. Returns true while the entity is committed
 * to its attack (callers hold position and skip other behavior).
 */
function resolveWindup(host: AiHost, zone: Zone, e: Entity, def: MonsterDef, now: number): boolean {
  if (!e.windupUntil) return false;
  if (now < e.windupUntil) {
    e.anim = 'attack'; // hold the telegraph pose
    return true;
  }
  e.windupUntil = undefined;
  e.attackCooldownUntil = now + def.attackCooldownMs;
  const target = e.windupTargetId ? zone.entities.get(e.windupTargetId) : undefined;
  e.windupTargetId = undefined;
  if (!target || target.dead) return false;
  const d = dist(e.x, e.y, target.x, target.y);
  if (d > def.attackRange * 1.4 + 0.4) return false; // sidestepped — the blow whiffs
  e.facing = Math.atan2(target.y - e.y, target.x - e.x);
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
    if (!target.dead) zone.impulse(target, e.x, e.y, 2.8); // the hit has weight
  }
  return false;
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

  // Hunger climbs while the belly is empty (predators only). Feeding — a
  // kill — resets it in GameServer.onEntityKilled.
  if (ai.drives) {
    ai.drives.hunger = Math.min(1, ai.drives.hunger + dt * HUNGER_PER_SEC);
  }

  // Committed to an attack? Hold the telegraph until it lands (or whiffs).
  if (resolveWindup(host, zone, e, def, now)) return;

  let target = validateTarget(zone, e, ai.roamUntil ? MONSTER_LEASH * 1.6 : MONSTER_LEASH);

  // Daily rhythm (overworld camps only): doze near the fire by day, prowl
  // wide at night. Nocturnal hunters barely react while the sun is up —
  // unless starvation overrides the nap.
  let aggro = def.aggroRange * clock.aggroMul;
  if (e.campId !== undefined && !ai.roamUntil) {
    ai.wanderRadius = clock.isNight ? 13 : 5;
    if (def.nocturnal) {
      const starving = (ai.drives?.hunger ?? 0) > 0.75;
      aggro *= clock.isNight || starving ? 1.25 : 0.35;
    }
  }

  if (!target && now >= ai.nextThink) {
    ai.nextThink = now + 250 + Math.random() * 200;
    target = scanForTarget(zone, e, aggro, 'players');
    if (!target) {
      // Hunt critters. Sated predators barely bother; hungry ones range far.
      const appetite = ai.drives ? 0.4 + ai.drives.hunger : 1;
      const preyRange = (e.variant === 'wolf' ? aggro * 1.15 : aggro * 0.6) * appetite;
      const hungryEnough = !ai.drives || ai.drives.hunger > 0.3;
      if (hungryEnough) target = scanForPrey(zone, e, preyRange);
    }
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
      e.anim = 'idle';
      tryAttack(host, zone, e, target, def, now); // sets 'attack' when it commits
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
  if (resolveWindup(host, zone, e, GUARD_COMBAT, now)) return;
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
  if (resolveWindup(host, zone, e, GUARD_COMBAT, now)) return;
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
