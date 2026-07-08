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

  // combat
  attackCooldownUntil?: number;
  slowUntil?: number;
  stunUntil?: number;
  /** Damage credit for XP: last player who hit this entity. */
  lastHitBy?: number;

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

  // portals
  portalId?: number;
  portalRole?: 'dungeon-entrance' | 'dungeon-exit';

  /** Spatial grid bookkeeping — do not touch. */
  _cell?: number;
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
  return snap;
}
