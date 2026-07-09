import type {
  EntityAnim,
  EntityKind,
  EntitySnapshot,
  Item,
  MonsterDef,
} from '@webmagic/shared';
import type { Vec2 } from '@webmagic/shared';

let nextEntityId = 1;

export function allocEntityId(): number {
  return nextEntityId++;
}

export type Faction = 'players' | 'monsters' | 'none';

export type AiMode = 'idle' | 'wander' | 'chase' | 'flee' | 'travel' | 'return';

/** A place in an NPC's daily schedule. `door` is the spot just outside the
 *  building's doorway — commutes route through it so nobody paths into walls. */
export interface RoutineStop {
  x: number;
  y: number;
  door?: Vec2;
}

export type VillagerActivity = 'work' | 'inn' | 'home';

export interface VillagerRoutine {
  home: RoutineStop;
  work: RoutineStop;
  inn: RoutineStop;
  activity?: VillagerActivity;
  /** Waypoints of the current commute (walked front to back). */
  commute?: Vec2[];
}

/**
 * Needs that accumulate over time and are satisfied by actions — the engine
 * of the life sim. A wolf's day emerges from one number: hunger climbs, it
 * hunts its forest; the forest runs dry, it leaves for the open world.
 */
export interface Drives {
  /** 0 = sated, 1 = starving. */
  hunger: number;
}

export interface AiState {
  mode: AiMode;
  /** Anchor the entity returns to / wanders around. */
  home: Vec2;
  wanderRadius: number;
  targetId?: number;
  /** Waypoints for 'travel' mode (caravans). */
  path?: Vec2[];
  pathIndex?: number;
  /** Next time this entity is allowed to think (staggered AI). */
  nextThink: number;
  /** Caravan: id of the caravan leader this guard escorts. */
  escortId?: number;
  fleeFromId?: number;
  /** Civilians flee their attacker until this passes. */
  fleeUntil?: number;

  // --- life sim
  /** Accumulating needs (predators hunger, prey just graze). */
  drives?: Drives;
  /** Named region this creature calls home (wolves: their forest). */
  regionId?: number;
  /** While set, this creature is on a hunger excursion away from home. */
  roamUntil?: number;

  // --- simulation LOD: entities nobody can see think and move coarsely
  lod?: 'near' | 'far';
  lodCheckAt?: number;
  /** Wall-clock time not yet simulated while far (drained on each far tick). */
  farAcc?: number;
  farNext?: number;

  // --- daily life
  /** Villagers: where they sleep, work and drink. */
  routine?: VillagerRoutine;
  /** Guards: patrol circuits for day and night shifts. */
  patrolDay?: Vec2[];
  patrolNight?: Vec2[];
  patrolIndex?: number;
  /** Pause at a patrol point / chat until this time. */
  waitUntil?: number;
  chatUntil?: number;
  chatPartnerId?: number;
  /** Next time this NPC may say a flavor line to nearby players. */
  sayNext?: number;
  /** Stuck detection for waypoint walking. */
  stuckPos?: Vec2;
  stuckSince?: number;
}

export interface Entity {
  id: number;
  kind: EntityKind;
  variant: string;
  x: number;
  y: number;
  facing: number;
  radius: number;
  speed: number;
  hp: number;
  maxHp: number;
  anim: EntityAnim;
  faction: Faction;
  name?: string;
  level?: number;
  light?: number;
  dead: boolean;
  /** Flavor text shown when a player interacts (signposts). Server-only. */
  interactText?: string;
  /** Height above ground (jumping players). Presentational — not in 2D collision. */
  z?: number;

  // combat
  attackCooldownUntil?: number;
  slowUntil?: number;
  stunUntil?: number;
  /** Damage credit for XP: last player who hit this entity. */
  lastHitBy?: number;
  /** Attack wind-up in progress: the blow lands when this passes (telegraph).
   *  A stagger during the wind-up cancels the attack. */
  windupUntil?: number;
  windupTargetId?: number;
  /** Knockback impulse (m/s), decayed by the zone each tick. */
  kx?: number;
  ky?: number;
  /** Big hits stagger, but not more often than once per second. */
  lastStaggerAt?: number;

  // monsters / npcs
  ai?: AiState;
  monsterDef?: MonsterDef;
  /** Camp index for respawning monsters. */
  campId?: number;

  // projectiles
  vx?: number;
  vy?: number;
  ttl?: number;
  damage?: number;
  ownerId?: number;
  slowMs?: number;
  /** Explode on impact, hitting everything hostile within this radius. */
  explodeRadius?: number;

  // loot
  item?: Item;
  despawnAt?: number;
  /** Freshly dropped loot can't be walked over again until this passes —
   *  otherwise dropping an item instantly picks it back up. */
  pickupCdUntil?: number;

  // portals
  portalId?: number;
  portalRole?: 'dungeon-entrance' | 'dungeon-exit';

  /** Spatial grid bookkeeping — do not touch. */
  _cell?: number;
  /** Snapshot cache: entities are encoded once per replication round and the
   *  result shared across every viewer (crowds would otherwise cost O(k²)). */
  _snap?: EntitySnapshot;
  _snapTick?: number;
}

/** Cached per-tick snapshot — encode once, share across all viewers. */
export function snapshotEntityCached(e: Entity, tick: number): EntitySnapshot {
  if (e._snapTick === tick && e._snap) return e._snap;
  e._snap = snapshotEntity(e);
  e._snapTick = tick;
  return e._snap;
}

export function snapshotEntity(e: Entity): EntitySnapshot {
  const snap: EntitySnapshot = {
    id: e.id,
    k: e.kind,
    v: e.variant,
    x: Math.round(e.x * 100) / 100,
    y: Math.round(e.y * 100) / 100,
    f: Math.round(e.facing * 100) / 100,
    hp: Math.ceil(e.hp),
    mhp: e.maxHp,
    a: e.anim,
  };
  if (e.name) snap.n = e.name;
  if (e.level) snap.lvl = e.level;
  if (e.light) snap.lt = e.light;
  if (e.z && e.z > 0.01) snap.z = Math.round(e.z * 100) / 100;
  return snap;
}
