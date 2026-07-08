/**
 * Weapon passive skills — always-on effects while the weapon is equipped.
 * Rolled on rarer weapons; the flashy ones are reserved for epics/legendaries.
 */
export type PassiveId =
  | 'following_light'
  | 'spinning_fireballs'
  | 'lifesteal'
  | 'thorns'
  | 'frost_aura';

export interface WeaponPassiveDef {
  id: PassiveId;
  name: string;
  desc: string;
  /** Tint for lights/particles this passive produces. */
  color: number;
}

export const PASSIVES: Record<PassiveId, WeaponPassiveDef> = {
  following_light: {
    id: 'following_light',
    name: 'Wisplight',
    desc: 'A radiant wisp orbits you, lighting the dark.',
    color: 0x88ddff,
  },
  spinning_fireballs: {
    id: 'spinning_fireballs',
    name: 'Cinder Orbit',
    desc: 'Fireballs circle you, scorching nearby enemies.',
    color: 0xff7722,
  },
  lifesteal: {
    id: 'lifesteal',
    name: 'Vampiric',
    desc: 'Heal for a portion of the damage you deal.',
    color: 0xcc3355,
  },
  thorns: {
    id: 'thorns',
    name: 'Spiteful',
    desc: 'Reflect a share of melee damage back at attackers.',
    color: 0xaaaab0,
  },
  frost_aura: {
    id: 'frost_aura',
    name: 'Rimeheart',
    desc: 'A chill aura slows enemies that draw near.',
    color: 0x66ccff,
  },
};

/** Weighted pool for random rolls — the showy actives are rarer. */
export const PASSIVE_POOL: PassiveId[] = [
  'lifesteal',
  'thorns',
  'frost_aura',
  'following_light',
  'spinning_fireballs',
];
