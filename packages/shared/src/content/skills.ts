export type SkillId =
  | 'slash'
  | 'whirlwind'
  | 'firebolt'
  | 'frost_nova'
  | 'bash'
  | 'holy_light';

export type SkillKind = 'melee' | 'projectile' | 'nova' | 'heal';

export interface SkillDef {
  id: SkillId;
  name: string;
  desc: string;
  kind: SkillKind;
  mpCost: number;
  cooldownMs: number;
  /** Max cast/hit range in meters (for melee: reach; for projectile: lifetime range). */
  range: number;
  /** AoE radius for nova skills. */
  radius?: number;
  /** Base damage / heal amount before scaling. */
  power: number;
  /** Which derived stat scales this skill (1 point = +2% power). */
  scale: 'melee' | 'spell';
  /** Projectile travel speed, m/s. */
  speed?: number;
  /** Emitted light color (hex) for projectiles / effects — feeds reactive lighting. */
  lightColor?: number;
  unlockLevel: number;
  slowMs?: number;
  stunMs?: number;
}

export const SKILLS: Record<SkillId, SkillDef> = {
  slash: {
    id: 'slash',
    name: 'Slash',
    desc: 'A quick sword strike in front of you.',
    kind: 'melee',
    mpCost: 0,
    cooldownMs: 600,
    range: 2.4,
    power: 12,
    scale: 'melee',
    unlockLevel: 1,
  },
  whirlwind: {
    id: 'whirlwind',
    name: 'Whirlwind',
    desc: 'Spin and hit every enemy around you.',
    kind: 'nova',
    mpCost: 12,
    cooldownMs: 5000,
    range: 0,
    radius: 3.5,
    power: 22,
    scale: 'melee',
    unlockLevel: 4,
    lightColor: 0xffcc66,
  },
  firebolt: {
    id: 'firebolt',
    name: 'Firebolt',
    desc: 'Hurl a bolt of fire that lights up the dark.',
    kind: 'projectile',
    mpCost: 6,
    cooldownMs: 800,
    range: 30,
    power: 16,
    scale: 'spell',
    speed: 18,
    lightColor: 0xff7722,
    unlockLevel: 1,
  },
  frost_nova: {
    id: 'frost_nova',
    name: 'Frost Nova',
    desc: 'Freeze the air, damaging and slowing everything nearby.',
    kind: 'nova',
    mpCost: 18,
    cooldownMs: 8000,
    range: 0,
    radius: 4.5,
    power: 18,
    scale: 'spell',
    slowMs: 2500,
    lightColor: 0x66ccff,
    unlockLevel: 4,
  },
  bash: {
    id: 'bash',
    name: 'Shield Bash',
    desc: 'Slam your shield into an enemy, briefly stunning it.',
    kind: 'melee',
    mpCost: 4,
    cooldownMs: 1200,
    range: 2.2,
    power: 10,
    scale: 'melee',
    stunMs: 800,
    unlockLevel: 1,
  },
  holy_light: {
    id: 'holy_light',
    name: 'Holy Light',
    desc: 'A burst of radiance that heals you and nearby allies.',
    kind: 'heal',
    mpCost: 16,
    cooldownMs: 9000,
    range: 0,
    radius: 5,
    power: 30,
    scale: 'spell',
    lightColor: 0xffeeaa,
    unlockLevel: 4,
  },
};
