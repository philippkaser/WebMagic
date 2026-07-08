import {
  Attributes,
  CLASSES,
  ClassId,
  DerivedStats,
  INVENTORY_SIZE,
  Item,
  ItemAffix,
  MAX_LEVEL,
  SKILLS,
  SkillId,
  Slot,
  addAttributes,
  deriveStats,
  xpForLevel,
  zeroBonuses,
  PLAYER_RADIUS,
} from '@webmagic/shared';
import { Entity, allocEntityId } from './entities';

/** The persisted shape of a character (see persist/store.ts). */
export interface PlayerRecord {
  name: string;
  classId: ClassId;
  level: number;
  xp: number;
  inventory: Item[];
  equipment: Partial<Record<Slot, Item>>;
  x: number;
  y: number;
  /** scrypt `salt:hash` of the account passphrase; absent = open name. */
  passHash?: string;
}

export interface DungeonRunState {
  dungeonId: string;
  portalId: number;
  floor: number;
  floorsDone: number;
}

export class Player {
  readonly entity: Entity;
  readonly name: string;
  readonly classId: ClassId;
  /** scrypt `salt:hash` of the account passphrase; undefined = open name. */
  passHash?: string;

  level: number;
  xp: number;
  mp: number;
  inventory: Item[];
  equipment: Partial<Record<Slot, Item>>;

  stats!: DerivedStats;
  attrs!: Attributes;

  cooldowns = new Map<SkillId, number>();
  lastInputSeq = 0;
  zoneId = 'overworld';
  dungeonRun: DungeonRunState | null = null;
  respawnAt = 0;
  /** Last safe overworld position — used for respawns and dungeon exits. */
  lastOverworld = { x: 0, y: 0 };

  constructor(record: PlayerRecord) {
    this.name = record.name;
    this.classId = record.classId;
    this.passHash = record.passHash;
    this.level = record.level;
    this.xp = record.xp;
    this.inventory = record.inventory;
    this.equipment = record.equipment;

    this.entity = {
      id: allocEntityId(),
      kind: 'player',
      variant: record.classId,
      x: record.x,
      y: record.y,
      facing: 0,
      radius: PLAYER_RADIUS,
      speed: 0,
      hp: 1,
      maxHp: 1,
      anim: 'idle',
      faction: 'players',
      name: record.name,
      level: record.level,
      dead: false,
      light: 0xffaa55, // carried lantern
    };

    this.recompute();
    this.entity.hp = this.stats.maxHp;
    this.mp = this.stats.maxMp;
  }

  /** Recompute derived stats from class, level, passive and equipment. */
  recompute(): void {
    const cls = CLASSES[this.classId];
    let attrs: Attributes = { ...cls.base };
    for (let l = 1; l < this.level; l++) {
      attrs = addAttributes(attrs, cls.perLevel);
      attrs = addAttributes(attrs, cls.passive.perLevel);
    }
    const bonuses = zeroBonuses();
    for (const item of Object.values(this.equipment)) {
      if (!item) continue;
      for (const affix of item.affixes) {
        this.applyAffix(affix, attrs, bonuses);
      }
    }
    this.attrs = attrs;
    const prevMax = this.stats?.maxHp;
    this.stats = deriveStats(attrs, bonuses);
    this.entity.maxHp = this.stats.maxHp;
    this.entity.speed = this.stats.moveSpeed;
    this.entity.level = this.level;
    if (prevMax && this.stats.maxHp > prevMax) {
      // Growing max HP keeps current HP proportional, never punishes equipping.
      this.entity.hp = Math.min(this.stats.maxHp, this.entity.hp + (this.stats.maxHp - prevMax));
    }
    this.entity.hp = Math.min(this.entity.hp, this.stats.maxHp);
    this.mp = Math.min(this.mp ?? this.stats.maxMp, this.stats.maxMp);
  }

  private applyAffix(affix: ItemAffix, attrs: Attributes, bonuses: ReturnType<typeof zeroBonuses>) {
    switch (affix.stat) {
      case 'str': attrs.str += affix.value; break;
      case 'int': attrs.int += affix.value; break;
      case 'vit': attrs.vit += affix.value; break;
      case 'armor': attrs.armor += affix.value; break;
      default: bonuses[affix.stat] += affix.value; break;
    }
  }

  /** @returns levels gained */
  addXp(amount: number): number {
    if (this.level >= MAX_LEVEL) return 0;
    this.xp += amount;
    let gained = 0;
    while (this.level < MAX_LEVEL && this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      gained++;
    }
    if (gained > 0) {
      this.recompute();
      this.entity.hp = this.stats.maxHp; // level-up fully heals
      this.mp = this.stats.maxMp;
    }
    return gained;
  }

  unlockedSkills(): SkillId[] {
    return CLASSES[this.classId].skills.filter((s) => SKILLS[s].unlockLevel <= this.level);
  }

  addItem(item: Item): boolean {
    if (this.inventory.length >= INVENTORY_SIZE) return false;
    this.inventory.push(item);
    return true;
  }

  removeItem(itemId: string): Item | null {
    const idx = this.inventory.findIndex((i) => i.id === itemId);
    if (idx === -1) return null;
    return this.inventory.splice(idx, 1)[0];
  }

  equip(itemId: string): boolean {
    const item = this.inventory.find((i) => i.id === itemId);
    if (!item) return false;
    this.removeItem(itemId);
    const current = this.equipment[item.slot];
    if (current) this.inventory.push(current);
    this.equipment[item.slot] = item;
    this.recompute();
    return true;
  }

  unequip(slot: Slot): boolean {
    const item = this.equipment[slot];
    if (!item) return false;
    if (this.inventory.length >= INVENTORY_SIZE) return false;
    delete this.equipment[slot];
    this.inventory.push(item);
    this.recompute();
    return true;
  }

  /** Strip everything collected in the current dungeon run (death penalty). */
  loseDungeonLoot(): number {
    let lost = 0;
    this.inventory = this.inventory.filter((i) => {
      if (i.dungeonLoot) { lost++; return false; }
      return true;
    });
    for (const slot of Object.keys(this.equipment) as Slot[]) {
      if (this.equipment[slot]?.dungeonLoot) {
        delete this.equipment[slot];
        lost++;
      }
    }
    if (lost > 0) this.recompute();
    return lost;
  }

  /** Mark all dungeon loot as safely extracted. */
  secureDungeonLoot(): void {
    for (const i of this.inventory) delete i.dungeonLoot;
    for (const i of Object.values(this.equipment)) if (i) delete i.dungeonLoot;
  }

  cooldownRemaining(skill: SkillId, now: number): number {
    const until = this.cooldowns.get(skill) ?? 0;
    return Math.max(0, until - now);
  }

  toRecord(): PlayerRecord {
    return {
      name: this.name,
      classId: this.classId,
      level: this.level,
      xp: this.xp,
      inventory: this.inventory,
      equipment: this.equipment,
      x: this.entity.x,
      y: this.entity.y,
      passHash: this.passHash,
    };
  }
}
