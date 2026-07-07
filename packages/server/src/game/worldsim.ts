import {
  DAY_LENGTH_MS,
  MONSTERS,
  OverworldData,
  Rng,
  hashSeed,
  tileCenter,
} from '@webmagic/shared';
import { Entity } from './entities';
import { Zone } from './zone';
import { spawnMonster, spawnNpc, spawnPortal } from './spawn';

export interface WorldSimHost {
  now(): number;
  systemNotice(text: string): void;
}

const VILLAGER_NAMES = ['Ada', 'Bram', 'Cora', 'Dane', 'Eda', 'Finn', 'Gerd', 'Hale', 'Ivo', 'Jyn'];
const CARAVAN_INTERVAL_MS = 75_000;
const MONSTER_RESPAWN_MS = 35_000;
const CORPSE_LINGER_MS = 4_000;

interface PendingRespawn {
  at: number;
  campId: number;
}

/**
 * The living overworld: villagers wander, guards patrol, monster camps
 * repopulate, and caravans haul goods between villages (and get ambushed).
 * All of it is plain simulation on the overworld zone — players just happen
 * to witness it.
 */
export class WorldSim {
  private readonly zone: Zone;
  private readonly world: OverworldData;
  private readonly rng: Rng;
  private nextCaravanAt = 0;
  private respawns: PendingRespawn[] = [];
  private corpses: { e: Entity; at: number }[] = [];
  private caravans = new Set<number>();

  constructor(zone: Zone, world: OverworldData, seed: number) {
    this.zone = zone;
    this.world = world;
    this.rng = new Rng(hashSeed(seed, 0xa11ce));
  }

  /** 0..1 — 0 is midnight, 0.5 is noon. */
  worldTime(now: number): number {
    // Start at 10:00 so new players see daylight first.
    return ((now + DAY_LENGTH_MS * 0.42) % DAY_LENGTH_MS) / DAY_LENGTH_MS;
  }

  isNight(now: number): boolean {
    const t = this.worldTime(now);
    return t < 0.22 || t > 0.8;
  }

  monsterAggroMultiplier(now: number): number {
    return this.isNight(now) ? 1.5 : 1;
  }

  populate(now: number): void {
    // Villages: villagers + guards
    for (const v of this.world.villages) {
      const center = tileCenter(v.cx, v.cy);
      const villagerCount = this.rng.int(4, 6);
      for (let i = 0; i < villagerCount; i++) {
        spawnNpc(this.zone, 'villager', center.x + this.rng.range(-6, 6), center.y + this.rng.range(-6, 6), {
          name: this.rng.pick(VILLAGER_NAMES),
          wanderRadius: v.radius * 1.6,
        });
      }
      const guardCount = 3;
      for (let i = 0; i < guardCount; i++) {
        const ang = (i / guardCount) * Math.PI * 2;
        spawnNpc(
          this.zone,
          'guard',
          center.x + Math.cos(ang) * (v.radius * 1.7),
          center.y + Math.sin(ang) * (v.radius * 1.7),
          { name: `${v.name} Guard`, wanderRadius: 8 }
        );
      }
    }

    // Monster camps
    for (const camp of this.world.camps) {
      const def = MONSTERS[camp.monster];
      const c = tileCenter(camp.cx, camp.cy);
      for (let i = 0; i < camp.count; i++) {
        spawnMonster(
          this.zone,
          def,
          c.x + this.rng.range(-camp.radius, camp.radius),
          c.y + this.rng.range(-camp.radius, camp.radius),
          camp.id
        );
      }
    }

    // Dungeon portals
    for (const p of this.world.portals) {
      const c = tileCenter(p.tx, p.ty);
      spawnPortal(this.zone, c.x, c.y, `${p.name} (Lv ${p.level}+)`, p.id, 'dungeon-entrance');
    }

    this.nextCaravanAt = now + 20_000;
  }

  tick(host: WorldSimHost): void {
    const now = host.now();

    // Camp respawns
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      if (now < r.at) continue;
      this.respawns.splice(i, 1);
      const camp = this.world.camps.find((c) => c.id === r.campId);
      if (!camp) continue;
      const c = tileCenter(camp.cx, camp.cy);
      spawnMonster(
        this.zone,
        MONSTERS[camp.monster],
        c.x + this.rng.range(-camp.radius, camp.radius),
        c.y + this.rng.range(-camp.radius, camp.radius),
        camp.id
      );
    }

    // Corpse cleanup
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      if (now >= this.corpses[i].at) {
        this.zone.removeEntity(this.corpses[i].e);
        this.corpses.splice(i, 1);
      }
    }

    // Caravans
    if (now >= this.nextCaravanAt && this.world.roads.length > 0) {
      this.nextCaravanAt = now + CARAVAN_INTERVAL_MS + this.rng.range(0, 30_000);
      this.spawnCaravan(host);
    }
  }

  private spawnCaravan(host: WorldSimHost): void {
    const road = this.rng.pick(this.world.roads);
    const forward = this.rng.chance(0.5);
    const path = forward ? [...road.points] : [...road.points].reverse();
    const from = this.world.villages.find((v) => v.id === (forward ? road.a : road.b))!;
    const to = this.world.villages.find((v) => v.id === (forward ? road.b : road.a))!;
    const start = path[0];
    const caravan = spawnNpc(this.zone, 'caravan', start.x, start.y, {
      name: `Caravan to ${to.name}`,
      path,
    });
    this.caravans.add(caravan.id);
    for (let i = 0; i < 2; i++) {
      spawnNpc(this.zone, 'caravan-guard', start.x + this.rng.range(-2, 2), start.y + this.rng.range(-2, 2), {
        name: 'Caravan Guard',
        escortId: caravan.id,
      });
    }
    host.systemNotice(`A caravan sets out from ${from.name}, bound for ${to.name}.`);
  }

  onCaravanArrived(host: WorldSimHost, caravan: Entity): void {
    if (!this.caravans.has(caravan.id)) return;
    this.caravans.delete(caravan.id);
    this.zone.removeEntity(caravan);
    // Dismiss the escort.
    for (const e of [...this.zone.entities.values()]) {
      if (e.variant === 'caravan-guard' && e.ai?.escortId === caravan.id) this.zone.removeEntity(e);
    }
    const name = caravan.name ?? 'A caravan';
    host.systemNotice(`${name} arrived safely. The village prospers.`);
  }

  onEntityKilled(host: WorldSimHost, victim: Entity): void {
    const now = host.now();
    if (victim.kind === 'monster') {
      if (victim.campId !== undefined) this.respawns.push({ at: now + MONSTER_RESPAWN_MS, campId: victim.campId });
      this.corpses.push({ e: victim, at: now + CORPSE_LINGER_MS });
      return;
    }
    if (victim.kind === 'npc') {
      this.corpses.push({ e: victim, at: now + CORPSE_LINGER_MS });
      if (victim.variant === 'caravan') {
        this.caravans.delete(victim.id);
        host.systemNotice(`${victim.name ?? 'A caravan'} was destroyed by monsters!`);
      } else if (victim.variant === 'guard') {
        host.systemNotice(`${victim.name ?? 'A guard'} has fallen in battle.`);
      }
    }
  }
}
