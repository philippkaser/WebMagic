import {
  DungeonFloorData,
  MONSTERS,
  MonsterDef,
  PortalDef,
  Rng,
  generateDungeonFloor,
  generateItem,
  hashSeed,
  scaledMonster,
} from '@webmagic/shared';
import { Zone } from './zone';
import { dropLoot, spawnFixture, spawnMonster, spawnPortal } from './spawn';

/** A champion: bigger, meaner, glowing — and always carrying loot. */
function championOf(def: MonsterDef): MonsterDef {
  return {
    ...def,
    name: `${def.name} Champion`,
    hp: Math.round(def.hp * 1.9),
    damage: Math.round(def.damage * 1.25),
    xp: Math.round(def.xp * 2.5),
    lootChance: 1,
    radius: Math.min(0.85, def.radius * 1.25),
  };
}

/**
 * One live dungeon run. Instances are shared: everyone who steps into the
 * same overworld portal while a run is open joins the same instance, which
 * is how ad-hoc multiplayer dungeon groups form. When the last player leaves,
 * the instance is disposed and the next visitor gets a freshly rolled one.
 */
export class DungeonInstance {
  readonly key: string;
  readonly portal: PortalDef;
  readonly seed: number;
  readonly floors = new Map<number, { zone: Zone; data: DungeonFloorData }>();

  constructor(key: string, portal: PortalDef, seed: number) {
    this.key = key;
    this.portal = portal;
    this.seed = seed;
  }

  playerCount(): number {
    let n = 0;
    for (const f of this.floors.values()) n += f.zone.players.size;
    return n;
  }

  getFloor(floor: number, now: number): { zone: Zone; data: DungeonFloorData } {
    let entry = this.floors.get(floor);
    if (entry) return entry;

    const data = generateDungeonFloor(this.seed, floor);
    const zone = new Zone(`${this.key}:${floor}`, 'dungeon', data.map, data.torches);
    const rng = new Rng(hashSeed(this.seed, floor, 0x100f));

    // Difficulty scales with both the portal's base level and the depth.
    // A few spawns roll up into champions — named threats with sure loot.
    const depthScale = floor + Math.floor(this.portal.level / 2);
    for (const spawn of data.monsterSpawns) {
      let def = scaledMonster(MONSTERS[spawn.monster], depthScale);
      const isChampion = rng.chance(0.13);
      if (isChampion) def = championOf(def);
      const m = spawnMonster(zone, def, spawn.x, spawn.y);
      if (isChampion) m.light = 0xc03040; // a red gleam in the dark marks it
    }

    // Floor loot piles — pre-rolled treasure lying in the dark.
    for (const l of data.lootSpawns) {
      // Deeper floors: higher item level AND better rarity odds (magic find).
      const item = generateItem(rng, this.portal.level + floor * 3, undefined, floor * 5);
      const loot = dropLoot(zone, l.x, l.y, item, now);
      loot.despawnAt = undefined; // floor loot never despawns
    }

    // A forgotten shrine on every floor: full restore + a short blessing,
    // once per player per 45s — the breather that shapes a floor's rhythm.
    const shrineAt = data.lootSpawns[data.lootSpawns.length - 1] ?? data.stairs;
    spawnFixture(zone, 'shrine', shrineAt.x + 0.9, shrineAt.y - 0.4, {
      name: 'Forgotten Shrine',
      interactText: 'Old magic answers your touch — your wounds close and your blood sings.',
      light: 0x66ffcc,
    });

    if (data.exitPortal) {
      spawnPortal(zone, data.exitPortal.x, data.exitPortal.y, 'Exit Portal', this.portal.id, 'dungeon-exit');
    }

    entry = { zone, data };
    this.floors.set(floor, entry);
    return entry;
  }
}

export class DungeonManager {
  private readonly worldSeed: number;
  private open = new Map<number, DungeonInstance>(); // portalId -> live instance
  private counter = 0;

  constructor(worldSeed: number) {
    this.worldSeed = worldSeed;
  }

  /** Get the joinable instance for a portal, creating one if needed. */
  enter(portal: PortalDef): DungeonInstance {
    let inst = this.open.get(portal.id);
    if (!inst) {
      this.counter++;
      const key = `dungeon:${portal.id}:${this.counter}`;
      inst = new DungeonInstance(key, portal, hashSeed(this.worldSeed, portal.id, this.counter, Date.now() & 0xffff));
      this.open.set(portal.id, inst);
    }
    return inst;
  }

  instanceByZoneId(zoneId: string): DungeonInstance | undefined {
    for (const inst of this.open.values()) {
      if (zoneId.startsWith(inst.key + ':')) return inst;
    }
    return undefined;
  }

  /** Dispose instances nobody is inside anymore. Returns removed zone ids. */
  reap(): string[] {
    const removedZones: string[] = [];
    for (const [portalId, inst] of this.open) {
      if (inst.playerCount() === 0) {
        for (const f of inst.floors.values()) removedZones.push(f.zone.id);
        this.open.delete(portalId);
      }
    }
    return removedZones;
  }

  allZones(): Zone[] {
    const zones: Zone[] = [];
    for (const inst of this.open.values()) {
      for (const f of inst.floors.values()) zones.push(f.zone);
    }
    return zones;
  }
}
