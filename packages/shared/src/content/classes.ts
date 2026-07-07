import type { Attributes } from './stats';
import type { SkillId } from './skills';

export type ClassId = 'warrior' | 'wizard' | 'knight';

export interface PassiveDef {
  name: string;
  desc: string;
  /** Attribute bonus granted per character level. */
  perLevel: Partial<Attributes>;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  desc: string;
  base: Attributes;
  perLevel: Attributes;
  skills: SkillId[];
  passive: PassiveDef;
  /** Basic attack used on left click / primary slot. */
  primary: SkillId;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  warrior: {
    id: 'warrior',
    name: 'Warrior',
    desc: 'A brutal melee fighter. High damage, close range.',
    base: { str: 8, int: 2, vit: 6, armor: 2 },
    perLevel: { str: 3, int: 1, vit: 2, armor: 1 },
    skills: ['slash', 'whirlwind'],
    primary: 'slash',
    passive: {
      name: 'Battle Fury',
      desc: 'Every level hardens you: bonus strength.',
      perLevel: { str: 1 },
    },
  },
  wizard: {
    id: 'wizard',
    name: 'Wizard',
    desc: 'A fragile master of destructive, glowing magic.',
    base: { str: 2, int: 9, vit: 4, armor: 0 },
    perLevel: { str: 1, int: 3, vit: 1, armor: 0 },
    skills: ['firebolt', 'frost_nova'],
    primary: 'firebolt',
    passive: {
      name: 'Arcane Mind',
      desc: 'Every level sharpens your mind: bonus intellect.',
      perLevel: { int: 1 },
    },
  },
  knight: {
    id: 'knight',
    name: 'Knight',
    desc: 'A protector clad in steel. Hard to kill, supports allies.',
    base: { str: 5, int: 4, vit: 8, armor: 4 },
    perLevel: { str: 2, int: 1, vit: 3, armor: 2 },
    skills: ['bash', 'holy_light'],
    primary: 'bash',
    passive: {
      name: 'Bulwark',
      desc: 'Every level thickens your plate: bonus armor.',
      perLevel: { armor: 1 },
    },
  },
};
