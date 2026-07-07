/** Primary attributes. Everything else derives from these + equipment affixes. */
export interface Attributes {
  str: number; // melee power
  int: number; // spell power, max mana
  vit: number; // max health
  armor: number; // flat damage reduction
}

/** Fully derived combat stats after class, level and equipment are applied. */
export interface DerivedStats {
  maxHp: number;
  maxMp: number;
  hpRegen: number; // per second
  mpRegen: number; // per second
  moveSpeed: number; // meters per second
  meleePower: number;
  spellPower: number;
  armor: number;
}

export const BASE_MOVE_SPEED = 6.5;

export function zeroAttributes(): Attributes {
  return { str: 0, int: 0, vit: 0, armor: 0 };
}

export function addAttributes(a: Attributes, b: Partial<Attributes>): Attributes {
  return {
    str: a.str + (b.str ?? 0),
    int: a.int + (b.int ?? 0),
    vit: a.vit + (b.vit ?? 0),
    armor: a.armor + (b.armor ?? 0),
  };
}

export interface StatBonuses {
  moveSpeed: number;
  hpRegen: number;
  mpRegen: number;
  meleePower: number;
  spellPower: number;
  maxHp: number;
  maxMp: number;
}

export function zeroBonuses(): StatBonuses {
  return { moveSpeed: 0, hpRegen: 0, mpRegen: 0, meleePower: 0, spellPower: 0, maxHp: 0, maxMp: 0 };
}

export function deriveStats(attrs: Attributes, bonuses: StatBonuses): DerivedStats {
  return {
    maxHp: 50 + attrs.vit * 10 + bonuses.maxHp,
    maxMp: 20 + attrs.int * 6 + bonuses.maxMp,
    hpRegen: 0.5 + attrs.vit * 0.05 + bonuses.hpRegen,
    mpRegen: 1 + attrs.int * 0.1 + bonuses.mpRegen,
    moveSpeed: BASE_MOVE_SPEED * (1 + bonuses.moveSpeed / 100),
    meleePower: attrs.str + bonuses.meleePower,
    spellPower: attrs.int + bonuses.spellPower,
    armor: attrs.armor,
  };
}

/** XP required to advance FROM the given level. */
export function xpForLevel(level: number): number {
  return Math.floor(40 * Math.pow(level, 1.5));
}

export const MAX_LEVEL = 50;
