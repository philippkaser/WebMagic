import { Rng } from '../math';
import type { SkillId } from './skills';

export type Slot = 'weapon' | 'armor' | 'helm' | 'boots' | 'trinket';
export type Rarity = 'common' | 'magic' | 'rare' | 'epic' | 'legendary';

export type AffixStat =
  | 'str'
  | 'int'
  | 'vit'
  | 'armor'
  | 'moveSpeed'
  | 'hpRegen'
  | 'mpRegen'
  | 'meleePower'
  | 'spellPower'
  | 'maxHp'
  | 'maxMp';

export interface ItemAffix {
  stat: AffixStat;
  value: number;
}

export interface Item {
  id: string;
  name: string;
  slot: Slot;
  rarity: Rarity;
  ilvl: number;
  affixes: ItemAffix[];
  /** Weapons define the left-click (primary) and right-click (secondary) skill. */
  weaponSkills?: { primary: SkillId; secondary: SkillId };
  /** True while carried inside a dungeon and not yet secured (lost on death). */
  dungeonLoot?: boolean;
}

/** Each weapon base grants a pair of skills — its left- and right-click. */
export const WEAPON_SKILLS: Record<string, { primary: SkillId; secondary: SkillId }> = {
  Sword: { primary: 'slash', secondary: 'whirlwind' },
  Blade: { primary: 'slash', secondary: 'frost_nova' },
  Axe: { primary: 'slash', secondary: 'whirlwind' },
  Mace: { primary: 'bash', secondary: 'holy_light' },
  Warhammer: { primary: 'bash', secondary: 'whirlwind' },
  Staff: { primary: 'firebolt', secondary: 'frost_nova' },
};

export const RARITY_ORDER: Rarity[] = ['common', 'magic', 'rare', 'epic', 'legendary'];

export const RARITY_COLORS: Record<Rarity, number> = {
  common: 0xbbbbbb,
  magic: 0x5599ff,
  rare: 0xffdd44,
  epic: 0xbb55ff,
  legendary: 0xff8833,
};

const AFFIX_COUNT: Record<Rarity, number> = {
  common: 0,
  magic: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

interface AffixTemplate {
  stat: AffixStat;
  /** value per item level, before rarity multiplier */
  perIlvl: number;
  min: number;
  prefix: string;
  suffix: string;
}

const AFFIX_POOL: AffixTemplate[] = [
  { stat: 'str', perIlvl: 0.8, min: 1, prefix: 'Savage', suffix: 'of the Bear' },
  { stat: 'int', perIlvl: 0.8, min: 1, prefix: 'Arcane', suffix: 'of the Owl' },
  { stat: 'vit', perIlvl: 0.8, min: 1, prefix: 'Stalwart', suffix: 'of the Boar' },
  { stat: 'armor', perIlvl: 0.6, min: 1, prefix: 'Fortified', suffix: 'of Stone' },
  { stat: 'moveSpeed', perIlvl: 0.5, min: 2, prefix: 'Swift', suffix: 'of the Wind' },
  { stat: 'hpRegen', perIlvl: 0.15, min: 0.5, prefix: 'Mending', suffix: 'of Renewal' },
  { stat: 'mpRegen', perIlvl: 0.2, min: 0.5, prefix: 'Humming', suffix: 'of Focus' },
  { stat: 'meleePower', perIlvl: 1.0, min: 2, prefix: 'Brutal', suffix: 'of Slaughter' },
  { stat: 'spellPower', perIlvl: 1.0, min: 2, prefix: 'Blazing', suffix: 'of Embers' },
  { stat: 'maxHp', perIlvl: 4, min: 5, prefix: 'Vigorous', suffix: 'of the Colossus' },
  { stat: 'maxMp', perIlvl: 3, min: 5, prefix: 'Shimmering', suffix: 'of the Deep' },
];

const BASE_NAMES: Record<Slot, string[]> = {
  weapon: ['Sword', 'Axe', 'Mace', 'Staff', 'Blade', 'Warhammer'],
  armor: ['Chainmail', 'Breastplate', 'Robe', 'Cuirass', 'Hauberk'],
  helm: ['Helm', 'Circlet', 'Hood', 'Greathelm', 'Cap'],
  boots: ['Boots', 'Greaves', 'Sandals', 'Treads'],
  trinket: ['Ring', 'Amulet', 'Talisman', 'Charm'],
};

const RARITY_MULT: Record<Rarity, number> = {
  common: 1,
  magic: 1,
  rare: 1.2,
  epic: 1.45,
  legendary: 1.8,
};

export const AFFIX_LABELS: Record<AffixStat, string> = {
  str: 'Strength',
  int: 'Intellect',
  vit: 'Vitality',
  armor: 'Armor',
  moveSpeed: '% Move Speed',
  hpRegen: 'Health / sec',
  mpRegen: 'Mana / sec',
  meleePower: 'Melee Power',
  spellPower: 'Spell Power',
  maxHp: 'Max Health',
  maxMp: 'Max Mana',
};

function rollRarity(rng: Rng, magicFind = 0): Rarity {
  const r = rng.next() * (1 - magicFind * 0.01);
  if (r < 0.02) return 'legendary';
  if (r < 0.07) return 'epic';
  if (r < 0.2) return 'rare';
  if (r < 0.5) return 'magic';
  return 'common';
}

let itemCounter = 0;

/**
 * Generate a random piece of equipment. Item power scales with `ilvl`
 * (usually the level of the monster or dungeon floor that dropped it).
 */
export function generateItem(rng: Rng, ilvl: number, forcedRarity?: Rarity): Item {
  const rarity = forcedRarity ?? rollRarity(rng);
  const slot = rng.pick(Object.keys(BASE_NAMES) as Slot[]);
  const base = rng.pick(BASE_NAMES[slot]);

  const count = AFFIX_COUNT[rarity];
  const pool = rng.shuffle([...AFFIX_POOL]);
  const affixes: ItemAffix[] = [];
  for (let i = 0; i < count && i < pool.length; i++) {
    const tpl = pool[i];
    const raw = Math.max(tpl.min, tpl.perIlvl * ilvl * RARITY_MULT[rarity] * rng.range(0.7, 1.3));
    affixes.push({ stat: tpl.stat, value: Math.round(raw * 10) / 10 });
  }
  // Every item gets an implicit slot stat so commons are not useless.
  const implicit: ItemAffix =
    slot === 'weapon'
      ? { stat: rng.chance(0.5) ? 'meleePower' : 'spellPower', value: Math.max(2, Math.round(1.2 * ilvl)) }
      : { stat: 'armor', value: Math.max(1, Math.round(0.5 * ilvl)) };
  affixes.unshift(implicit);

  let name = base;
  if (affixes.length > 1) {
    const strongest = pool[0];
    name = rng.chance(0.5) ? `${strongest.prefix} ${base}` : `${base} ${strongest.suffix}`;
    if (rarity === 'epic' || rarity === 'legendary') {
      name = `${pool[1]?.prefix ?? 'Ancient'} ${name}`;
    }
  }

  const item: Item = {
    id: `it_${Date.now().toString(36)}_${(itemCounter++).toString(36)}`,
    name,
    slot,
    rarity,
    ilvl,
    affixes,
  };
  if (slot === 'weapon') item.weaponSkills = WEAPON_SKILLS[base] ?? WEAPON_SKILLS.Sword;
  return item;
}
