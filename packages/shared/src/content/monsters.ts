export type MonsterId =
  | 'goblin'
  | 'wolf'
  | 'orc'
  | 'skeleton'
  | 'imp'
  | 'ogre'
  | 'slime'
  | 'slimelet'
  | 'spider';

export interface MonsterDef {
  id: MonsterId;
  name: string;
  level: number;
  hp: number;
  damage: number;
  speed: number;
  radius: number;
  aggroRange: number;
  attackRange: number;
  attackCooldownMs: number;
  xp: number;
  /** Chance to drop a generated item on death (0..1). */
  lootChance: number;
  /** Ranged monsters fire a projectile instead of striking. */
  projectile?: { speed: number; lightColor: number; aoeRadius?: number };
  /** Where this monster naturally lives. */
  habitat: 'overworld' | 'dungeon';
  /** Nocturnal hunters doze through the day and roam wide at night. */
  nocturnal?: boolean;
  /** Predators live by hunger: they hunt prey to eat, and starvation drives
   *  them out of their home region to roam the open world. */
  predator?: boolean;
  /** On death, spawn smaller monsters (slimes splitting). */
  splitInto?: { id: MonsterId; count: number };
}

export const MONSTERS: Record<MonsterId, MonsterDef> = {
  goblin: {
    id: 'goblin',
    name: 'Goblin',
    level: 1,
    hp: 35,
    damage: 6,
    speed: 4.5,
    radius: 0.4,
    aggroRange: 9,
    attackRange: 1.6,
    attackCooldownMs: 1300,
    xp: 12,
    lootChance: 0.25,
    habitat: 'overworld',
  },
  wolf: {
    id: 'wolf',
    name: 'Dire Wolf',
    level: 2,
    hp: 45,
    damage: 8,
    speed: 7,
    radius: 0.45,
    aggroRange: 11,
    attackRange: 1.5,
    attackCooldownMs: 1100,
    xp: 18,
    lootChance: 0.2,
    habitat: 'overworld',
    nocturnal: true,
    predator: true,
  },
  orc: {
    id: 'orc',
    name: 'Orc Raider',
    level: 4,
    hp: 90,
    damage: 14,
    speed: 4,
    radius: 0.5,
    aggroRange: 10,
    attackRange: 1.8,
    attackCooldownMs: 1600,
    xp: 35,
    lootChance: 0.35,
    habitat: 'overworld',
  },
  skeleton: {
    id: 'skeleton',
    name: 'Skeleton',
    level: 3,
    hp: 55,
    damage: 10,
    speed: 4.2,
    radius: 0.4,
    aggroRange: 10,
    attackRange: 1.6,
    attackCooldownMs: 1400,
    xp: 25,
    lootChance: 0.3,
    habitat: 'dungeon',
  },
  imp: {
    id: 'imp',
    name: 'Imp',
    level: 4,
    hp: 40,
    damage: 12,
    speed: 3.8,
    radius: 0.35,
    aggroRange: 12,
    attackRange: 9,
    attackCooldownMs: 2200,
    xp: 30,
    lootChance: 0.3,
    projectile: { speed: 12, lightColor: 0xff4422, aoeRadius: 1.6 },
    habitat: 'dungeon',
  },
  ogre: {
    id: 'ogre',
    name: 'Ogre',
    level: 7,
    hp: 240,
    damage: 24,
    speed: 3.2,
    radius: 0.7,
    aggroRange: 10,
    attackRange: 2.2,
    attackCooldownMs: 2000,
    xp: 110,
    lootChance: 0.9,
    habitat: 'dungeon',
  },
  slime: {
    id: 'slime',
    name: 'Gelatinous Slime',
    level: 2,
    hp: 70,
    damage: 9,
    speed: 2.8,
    radius: 0.5,
    aggroRange: 8,
    attackRange: 1.6,
    attackCooldownMs: 1500,
    xp: 22,
    lootChance: 0.2,
    habitat: 'dungeon',
    // Cleaving one open just makes two smaller ones.
    splitInto: { id: 'slimelet', count: 2 },
  },
  slimelet: {
    id: 'slimelet',
    name: 'Slimelet',
    level: 1,
    hp: 22,
    damage: 5,
    speed: 3.6,
    radius: 0.3,
    aggroRange: 9,
    attackRange: 1.3,
    attackCooldownMs: 1200,
    xp: 8,
    lootChance: 0.05,
    habitat: 'dungeon',
  },
  spider: {
    id: 'spider',
    name: 'Cave Spider',
    level: 3,
    hp: 34,
    damage: 8,
    speed: 6.8,
    radius: 0.38,
    aggroRange: 13,
    attackRange: 1.4,
    attackCooldownMs: 900,
    xp: 20,
    lootChance: 0.18,
    habitat: 'dungeon',
  },
};

/** Scale a monster definition for deeper dungeon floors. */
export function scaledMonster(def: MonsterDef, floor: number): MonsterDef {
  if (floor <= 0) return def;
  const m = 1 + floor * 0.35;
  return {
    ...def,
    level: def.level + floor,
    hp: Math.round(def.hp * m),
    damage: Math.round(def.damage * (1 + floor * 0.25)),
    xp: Math.round(def.xp * m),
  };
}
