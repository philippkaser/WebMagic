import {
  DAY_LENGTH_MS,
  HouseDef,
  MONSTERS,
  OverworldData,
  Rng,
  TILE_SIZE,
  Vec2,
  dist,
  hashSeed,
  tileCenter,
} from '@webmagic/shared';
import { Entity, RoutineStop } from './entities';
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
const RAID_CHECK_MS = 100_000;
const RAID_DURATION_MS = 150_000;

interface PendingRespawn {
  at: number;
  campId: number;
}

interface ActiveRaid {
  campId: number;
  monsterIds: number[];
  until: number;
}

/** World point just outside a house's door — commute waypoint. */
function doorStep(h: HouseDef): Vec2 {
  const d = tileCenter(h.door.x, h.door.y);
  return { x: d.x, y: d.y + TILE_SIZE * 1.2 }; // doors face south
}

function houseInterior(h: HouseDef): Vec2 {
  return tileCenter(h.x + Math.floor(h.w / 2), h.y + Math.floor(h.h / 2));
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
  private readonly dayLengthMs: number;
  private nextCaravanAt = 0;
  private nextRaidAt = 0;
  private raids: ActiveRaid[] = [];
  private respawns: PendingRespawn[] = [];
  private corpses: { e: Entity; at: number }[] = [];
  private caravans = new Set<number>();

  constructor(zone: Zone, world: OverworldData, seed: number, dayLengthMs = DAY_LENGTH_MS) {
    this.zone = zone;
    this.world = world;
    this.rng = new Rng(hashSeed(seed, 0xa11ce));
    this.dayLengthMs = dayLengthMs;
  }

  /** 0..1 — 0 is midnight, 0.5 is noon. */
  worldTime(now: number): number {
    // Start at 10:00 so new players see daylight first.
    return ((now + this.dayLengthMs * 0.42) % this.dayLengthMs) / this.dayLengthMs;
  }

  isNight(now: number): boolean {
    const t = this.worldTime(now);
    return t < 0.22 || t > 0.8;
  }

  monsterAggroMultiplier(now: number): number {
    return this.isNight(now) ? 1.5 : 1;
  }

  /** Random unblocked spot near the village center (work sites, hangouts). */
  private openSpot(cx: number, cy: number, radius: number): Vec2 {
    for (let i = 0; i < 12; i++) {
      const p = { x: cx + this.rng.range(-radius, radius), y: cy + this.rng.range(-radius, radius) };
      if (!this.world.map.blockedAtWorld(p.x, p.y)) return p;
    }
    return { x: cx, y: cy };
  }

  populate(now: number): void {
    // Villages: villagers with real daily routines + guards on patrol circuits
    for (const v of this.world.villages) {
      const center = tileCenter(v.cx, v.cy);
      const inn = v.houses.find((h) => h.isInn) ?? v.houses[0];
      const homes = v.houses.filter((h) => !h.isInn);
      const villagerCount = this.rng.int(4, 6);
      for (let i = 0; i < villagerCount; i++) {
        const house = homes.length > 0 ? homes[i % homes.length] : inn;
        const bed = houseInterior(house);
        const innSeat = houseInterior(inn);
        const home: RoutineStop = {
          x: bed.x + this.rng.range(-0.8, 0.8),
          y: bed.y + this.rng.range(-0.8, 0.8),
          door: doorStep(house),
        };
        const innStop: RoutineStop = {
          x: innSeat.x + this.rng.range(-1.5, 1.5),
          y: innSeat.y + this.rng.range(-1.2, 1.2),
          door: doorStep(inn),
        };
        const work: RoutineStop = this.openSpot(center.x, center.y, v.radius * TILE_SIZE * 0.7);
        spawnNpc(this.zone, 'villager', home.x, home.y, {
          name: this.rng.pick(VILLAGER_NAMES),
          wanderRadius: 4,
          routine: { home, work, inn: innStop },
        });
      }

      const guardCount = 3;
      const dayRing: Vec2[] = [];
      const nightRing: Vec2[] = [];
      const ringPoints = 6;
      for (let p = 0; p < ringPoints; p++) {
        const ang = (p / ringPoints) * Math.PI * 2;
        dayRing.push({
          x: center.x + Math.cos(ang) * v.radius * TILE_SIZE * 0.85,
          y: center.y + Math.sin(ang) * v.radius * TILE_SIZE * 0.85,
        });
        if (p % 2 === 0) {
          nightRing.push({
            x: center.x + Math.cos(ang) * v.radius * TILE_SIZE * 0.35,
            y: center.y + Math.sin(ang) * v.radius * TILE_SIZE * 0.35,
          });
        }
      }
      for (let i = 0; i < guardCount; i++) {
        const start = dayRing[(i * 2) % dayRing.length];
        spawnNpc(this.zone, 'guard', start.x, start.y, {
          name: `${v.name} Guard`,
          wanderRadius: 8,
          // stagger each guard's circuit so they don't bunch up
          patrolDay: [...dayRing.slice(i * 2), ...dayRing.slice(0, i * 2)],
          patrolNight: [...nightRing.slice(i), ...nightRing.slice(0, i)],
        });
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

    // Caravans — merchants only travel by daylight
    if (now >= this.nextCaravanAt && this.world.roads.length > 0) {
      if (this.isNight(now)) {
        this.nextCaravanAt = now + 20_000; // wait for dawn
      } else {
        this.nextCaravanAt = now + CARAVAN_INTERVAL_MS + this.rng.range(0, 30_000);
        this.spawnCaravan(host);
      }
    }

    this.tickRaids(host, now);
  }

  /**
   * Night raids: a few monsters march from their camp to the edge of the
   * nearest village and harass it until dawn drives them home. Guards fight
   * back, villagers flee — all emergent from the regular AI.
   */
  private tickRaids(host: WorldSimHost, now: number): void {
    // send survivors home when a raid ends
    for (let i = this.raids.length - 1; i >= 0; i--) {
      const raid = this.raids[i];
      if (now < raid.until && this.isNight(now)) continue;
      const camp = this.world.camps.find((c) => c.id === raid.campId);
      for (const id of raid.monsterIds) {
        const m = this.zone.entities.get(id);
        if (m && !m.dead && m.ai && camp) {
          const c = tileCenter(camp.cx, camp.cy);
          m.ai.home = { x: c.x + this.rng.range(-3, 3), y: c.y + this.rng.range(-3, 3) };
          m.ai.wanderRadius = 5;
          m.ai.path = [{ x: c.x, y: c.y }];
        }
      }
      this.raids.splice(i, 1);
    }

    if (!this.isNight(now) || now < this.nextRaidAt) return;
    this.nextRaidAt = now + RAID_CHECK_MS + this.rng.range(0, 60_000);
    if (!this.rng.chance(0.65)) return;

    // pick a camp that still has monsters, raid its nearest village
    const camps = this.rng.shuffle([...this.world.camps]);
    for (const camp of camps) {
      const raiders = [...this.zone.entities.values()]
        .filter((m) => m.kind === 'monster' && m.campId === camp.id && !m.dead && m.ai)
        .slice(0, 3);
      if (raiders.length < 2) continue;

      const campC = tileCenter(camp.cx, camp.cy);
      let village = this.world.villages[0];
      let best = Infinity;
      for (const v of this.world.villages) {
        const c = tileCenter(v.cx, v.cy);
        const d = dist(campC.x, campC.y, c.x, c.y);
        if (d < best) {
          best = d;
          village = v;
        }
      }
      const vc = tileCenter(village.cx, village.cy);
      const len = Math.max(1, dist(vc.x, vc.y, campC.x, campC.y));
      const dirX = (campC.x - vc.x) / len;
      const dirY = (campC.y - vc.y) / len;
      const edge = {
        x: vc.x + dirX * (village.radius * TILE_SIZE + 5),
        y: vc.y + dirY * (village.radius * TILE_SIZE + 5),
      };
      for (const m of raiders) {
        m.ai!.home = { x: edge.x + this.rng.range(-3, 3), y: edge.y + this.rng.range(-3, 3) };
        m.ai!.wanderRadius = 9;
        m.ai!.path = [{ x: edge.x, y: edge.y }];
      }
      this.raids.push({ campId: camp.id, monsterIds: raiders.map((m) => m.id), until: now + RAID_DURATION_MS });
      host.systemNotice(`⚔ ${MONSTERS[camp.monster].name} raiders are marching on ${village.name}!`);
      return;
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
