import {
  Item,
  LOOT_TTL_MS,
  MonsterDef,
  RARITY_COLORS,
  Vec2,
} from '@webmagic/shared';
import { Entity, VillagerRoutine, allocEntityId } from './entities';
import { Zone } from './zone';
import { GUARD_COMBAT } from './ai';

export function spawnMonster(zone: Zone, def: MonsterDef, x: number, y: number, campId?: number): Entity {
  const e: Entity = {
    id: allocEntityId(),
    kind: 'monster',
    variant: def.id,
    x,
    y,
    facing: Math.random() * Math.PI * 2,
    radius: def.radius,
    speed: def.speed,
    hp: def.hp,
    maxHp: def.hp,
    anim: 'idle',
    faction: 'monsters',
    name: def.name,
    level: def.level,
    dead: false,
    monsterDef: def,
    campId,
    ai: { mode: 'wander', home: { x, y }, wanderRadius: 6, nextThink: 0 },
  };
  zone.addEntity(e);
  return e;
}

export function spawnNpc(
  zone: Zone,
  variant: 'villager' | 'guard' | 'caravan' | 'caravan-guard',
  x: number,
  y: number,
  opts: {
    name?: string;
    wanderRadius?: number;
    path?: Vec2[];
    escortId?: number;
    routine?: VillagerRoutine;
    patrolDay?: Vec2[];
    patrolNight?: Vec2[];
  } = {}
): Entity {
  const isGuard = variant === 'guard' || variant === 'caravan-guard';
  const hp = isGuard ? GUARD_COMBAT.hp : variant === 'caravan' ? 120 : 40;
  const e: Entity = {
    id: allocEntityId(),
    kind: 'npc',
    variant,
    x,
    y,
    facing: Math.random() * Math.PI * 2,
    radius: variant === 'caravan' ? 0.6 : 0.42,
    speed: isGuard ? GUARD_COMBAT.speed : variant === 'caravan' ? 3.4 : 2.5,
    hp,
    maxHp: hp,
    anim: 'idle',
    faction: 'players', // villagers/guards/caravans are allied with players
    name: opts.name,
    dead: false,
    monsterDef: isGuard ? GUARD_COMBAT : undefined,
    ai: {
      mode: variant === 'caravan' ? 'travel' : 'wander',
      home: { x, y },
      wanderRadius: opts.wanderRadius ?? 5,
      nextThink: 0,
      path: opts.path,
      pathIndex: opts.path ? 0 : undefined,
      escortId: opts.escortId,
      routine: opts.routine,
      patrolDay: opts.patrolDay,
      patrolNight: opts.patrolNight,
      patrolIndex: 0,
    },
  };
  zone.addEntity(e);
  return e;
}

/** A harmless ambient critter (chicken…): wanders, can't fight or be targeted. */
export function spawnCritter(zone: Zone, variant: string, x: number, y: number): Entity {
  const e: Entity = {
    id: allocEntityId(),
    kind: 'npc',
    variant,
    x,
    y,
    facing: Math.random() * Math.PI * 2,
    radius: 0.28,
    speed: 1.7,
    hp: 5,
    maxHp: 5,
    anim: 'idle',
    faction: 'none', // never a combat target
    dead: false,
    ai: { mode: 'wander', home: { x, y }, wanderRadius: 6, nextThink: 0 },
  };
  zone.addEntity(e);
  return e;
}

export function spawnPortal(
  zone: Zone,
  x: number,
  y: number,
  name: string,
  portalId: number,
  role: 'dungeon-entrance' | 'dungeon-exit'
): Entity {
  const e: Entity = {
    id: allocEntityId(),
    kind: 'portal',
    variant: role === 'dungeon-entrance' ? 'portal' : 'portal-exit',
    x,
    y,
    facing: 0,
    radius: 0.8,
    speed: 0,
    hp: 1,
    maxHp: 1,
    anim: 'idle',
    faction: 'none',
    name,
    dead: false,
    portalId,
    portalRole: role,
    light: role === 'dungeon-entrance' ? 0x9944ff : 0x44ddff,
  };
  zone.addEntity(e);
  return e;
}

export function dropLoot(zone: Zone, x: number, y: number, item: Item, now: number): Entity {
  const e: Entity = {
    id: allocEntityId(),
    kind: 'loot',
    variant: item.rarity,
    x,
    y,
    facing: 0,
    radius: 0.4,
    speed: 0,
    hp: 1,
    maxHp: 1,
    anim: 'idle',
    faction: 'none',
    name: item.name,
    dead: false,
    item,
    despawnAt: now + LOOT_TTL_MS,
    light: item.rarity !== 'common' ? RARITY_COLORS[item.rarity] : undefined,
  };
  zone.addEntity(e);
  return e;
}
