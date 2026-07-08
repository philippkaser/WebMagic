import {
  DungeonFloorData,
  MONSTERS,
  PortalDef,
  Rng,
  generateDungeonFloor,
  generateItem,
  hashSeed,
  scaledMonster,
} from '@webmagic/shared';
import { Zone } from './zone';
import { dropLoot, spawnMonster, spawnPortal } from './spawn';

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

    // Difficulty scales with both the portal's base level and the depth.
    const depthScale = floor + Math.floor(this.portal.level / 2);
    for (const spawn of data.monsterSpawns) {
      spawnMonster(zone, scaledMonster(MONSTERS[spawn.monster], depthScale), spawn.x, spawn.y);
    }

    // Floor loot piles — pre-rolled treasure lying in the dark.
    const rng = new Rng(hashSeed(this.seed, floor, 0x100f));
    for (const l of data.lootSpawns) {
      // Deeper floors: higher item level AND better rarity odds (magic find).
      const item = generateItem(rng, this.portal.level + floor * 3, undefined, floor * 5);
      const loot = dropLoot(zone, l.x, l.y, item, now);
      loot.despawnAt = undefined; // floor loot never despawns
    }

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
