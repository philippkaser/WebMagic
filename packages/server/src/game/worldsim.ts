import {
  DAY_LENGTH_MS,
  HouseDef,
  MONSTERS,
  OverworldData,
  RegionDef,
  Rng,
  TILE_SIZE,
  Vec2,
  dist,
  hashSeed,
  tileCenter,
} from '@webmagic/shared';
import { Entity, RoutineStop } from './entities';
import { Zone } from './zone';
import { spawnCritter, spawnFixture, spawnMonster, spawnNpc, spawnPortal } from './spawn';

const SIGN_LINES = [
  'Rest here. The wilds beyond do not forgive the careless.',
  'Keep the caravans safe and the lanterns lit.',
  'Portals to the deep lie in the wilds. Fortune and teeth await.',
  'Nightfall brings raiders. Stand with the guards or run.',
];

export interface WorldSimHost {
  now(): number;
  systemNotice(text: string): void;
}

const VILLAGER_NAMES = ['Ada', 'Bram', 'Cora', 'Dane', 'Eda', 'Finn', 'Gerd', 'Hale', 'Ivo', 'Jyn'];
const CARAVAN_INTERVAL_MS = 38_000;
const MONSTER_RESPAWN_MS = 35_000;
const CORPSE_LINGER_MS = 4_000;
const RAID_CHECK_MS = 100_000;
const RAID_DURATION_MS = 150_000;
// The event director keeps something happening every ~11–19s.
const EVENT_INTERVAL_MS = 11_000;
// Life sim cadences: cheap censuses, not per-tick work.
const DEER_CHECK_MS = 22_000;
const WOLF_CHECK_MS = 8_000;
const EXCURSION_MS = 160_000;

const TRAVELER_TITLES = ['a wandering peddler', 'a hooded pilgrim', 'a road-weary bard', 'a lost traveler', 'a tax collector'];
const WILD_FLAVOR = [
  'A cold wind sweeps down from the mountains.',
  'Somewhere far off, a wolf howls.',
  'Crows wheel over the treeline.',
  'The lanterns gutter in a sudden breeze.',
  'Distant thunder rolls beyond the hills.',
  'Birdsong drifts across the fields.',
  'The scent of rain hangs in the air.',
  'Leaves skitter across the road.',
];
const OMENS = [
  '✦ A star falls, streaking green across the sky.',
  '✦ The air hums — somewhere in the deep, a portal flares.',
  '✦ The moon reddens for a moment. An ill omen.',
  '✦ A distant horn sounds three times, then falls silent.',
];

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
  private nextEventAt = 0;
  private raids: ActiveRaid[] = [];
  private respawns: PendingRespawn[] = [];
  private corpses: { e: Entity; at: number }[] = [];
  private caravans = new Set<number>();
  // --- life sim state
  /** Deer population target per forest region — the prey base wolves depend on. */
  private deerTargets = new Map<number, number>();
  private nextDeerCheckAt = 0;
  /** campId -> excursion end time for wolf packs currently out of their forest. */
  private roamingPacks = new Map<number, number>();
  private nextWolfCheckAt = 0;

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

      // A few chickens pecking around to make the village feel lived-in.
      const chickenCount = this.rng.int(2, 4);
      for (let i = 0; i < chickenCount; i++) {
        const spot = this.openSpot(center.x, center.y, v.radius * TILE_SIZE * 0.6);
        spawnCritter(this.zone, 'chicken', spot.x, spot.y);
      }

      // A campfire to rest at, and a signpost to read.
      const fire = this.openSpot(center.x, center.y, v.radius * TILE_SIZE * 0.35);
      spawnFixture(this.zone, 'campfire', fire.x, fire.y, { light: 0xff8a3c });
      const sign = this.openSpot(center.x, center.y, v.radius * TILE_SIZE * 0.55);
      spawnFixture(this.zone, 'signpost', sign.x, sign.y, {
        name: v.name,
        interactText: `${v.name} — ${this.rng.pick(SIGN_LINES)}`,
      });
    }

    // Wild deer: herds living in the named forests — the prey base the wolf
    // packs depend on. When a forest runs out of deer, its wolves go hungry,
    // and hungry wolves leave the woods. A couple of meadow herds roam the
    // open country for travellers to startle.
    const forests = this.world.regions.filter((r) => r.kind === 'forest');
    for (const forest of forests) {
      const target = Math.max(3, Math.min(6, Math.round(forest.tiles / 140)));
      this.deerTargets.set(forest.id, target);
      for (let i = 0; i < target; i++) this.spawnDeerIn(forest);
    }
    for (let h = 0; h < 2; h++) {
      let spot: Vec2 | null = null;
      for (let tries = 0; tries < 20; tries++) {
        const p = tileCenter(
          this.rng.int(16, this.world.map.w - 16),
          this.rng.int(16, this.world.map.h - 16)
        );
        if (this.world.map.blockedAtWorld(p.x, p.y)) continue;
        if (this.world.villages.some((v) => {
          const vc = tileCenter(v.cx, v.cy);
          return dist(p.x, p.y, vc.x, vc.y) < 24;
        })) continue;
        spot = p;
        break;
      }
      if (!spot) continue;
      const herdSize = this.rng.int(2, 3);
      for (let i = 0; i < herdSize; i++) {
        const d = this.openSpot(spot.x, spot.y, 6);
        const deer = spawnCritter(this.zone, 'deer', d.x, d.y);
        deer.speed = 2.4; // deer graze at a decent clip
        if (deer.ai) deer.ai.wanderRadius = 8;
      }
    }

    // Monster camps (wolf dens carry their forest's regionId)
    for (const camp of this.world.camps) {
      const def = MONSTERS[camp.monster];
      const c = tileCenter(camp.cx, camp.cy);
      for (let i = 0; i < camp.count; i++) {
        spawnMonster(
          this.zone,
          def,
          c.x + this.rng.range(-camp.radius, camp.radius),
          c.y + this.rng.range(-camp.radius, camp.radius),
          camp.id,
          camp.regionId
        );
      }
    }

    // Dungeon portals
    for (const p of this.world.portals) {
      const c = tileCenter(p.tx, p.ty);
      spawnPortal(this.zone, c.x, c.y, `${p.name} (Lv ${p.level}+)`, p.id, 'dungeon-entrance');
    }

    // Wilderness landmarks: shrines to rest at, obelisks to read, and ruins
    // guarded by monsters (with a chance of buried loot).
    for (const poi of this.world.pois) {
      if (poi.kind === 'shrine') {
        spawnFixture(this.zone, 'shrine', poi.x, poi.y, {
          name: 'Wayside Shrine',
          interactText: poi.text,
          light: 0x66ffcc,
        });
      } else if (poi.kind === 'obelisk') {
        spawnFixture(this.zone, 'obelisk', poi.x, poi.y, {
          name: 'Ancient Obelisk',
          interactText: poi.text,
          light: 0x8a6bff,
        });
      } else {
        // Ruin: a couple of guardian monsters lurking among the broken walls.
        const guard = this.rng.pick(['goblin', 'orc', 'skeleton'] as const);
        const n = this.rng.int(2, 3);
        for (let i = 0; i < n; i++) {
          spawnMonster(
            this.zone,
            MONSTERS[guard],
            poi.x + this.rng.range(-3, 3),
            poi.y + this.rng.range(-3, 3)
          );
        }
        spawnFixture(this.zone, 'obelisk', poi.x, poi.y, {
          name: 'Ruined Marker',
          interactText: 'Crumbling stones — whatever stood here fell long ago.',
        });
      }
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
        camp.id,
        camp.regionId
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
    this.tickWolfPacks(host, now);
    this.tickDeerPopulation(now);
    this.runEvents(host, now);
  }

  /** A deer materializes near its forest's heart, on open ground. */
  private spawnDeerIn(forest: RegionDef): void {
    const c = tileCenter(forest.cx, forest.cy);
    const reach = forest.radius * TILE_SIZE * 0.7;
    for (let tries = 0; tries < 16; tries++) {
      const p = { x: c.x + this.rng.range(-reach, reach), y: c.y + this.rng.range(-reach, reach) };
      if (this.world.map.blockedAtWorld(p.x, p.y)) continue;
      const deer = spawnCritter(this.zone, 'deer', p.x, p.y, forest.id);
      deer.speed = 2.4;
      if (deer.ai) deer.ai.wanderRadius = 9;
      return;
    }
  }

  /**
   * Forest ecology: deer herds regrow slowly toward each forest's carrying
   * capacity. Overhunt a forest — wolves or players — and its pack starves.
   */
  private tickDeerPopulation(now: number): void {
    if (now < this.nextDeerCheckAt) return;
    this.nextDeerCheckAt = now + DEER_CHECK_MS;
    if (this.deerTargets.size === 0) return;

    const counts = new Map<number, number>();
    for (const e of this.zone.entities.values()) {
      if (e.dead || e.variant !== 'deer' || e.ai?.regionId === undefined) continue;
      counts.set(e.ai.regionId, (counts.get(e.ai.regionId) ?? 0) + 1);
    }
    for (const [regionId, target] of this.deerTargets) {
      if ((counts.get(regionId) ?? 0) >= target) continue;
      const forest = this.world.regions.find((r) => r.id === regionId);
      if (forest) this.spawnDeerIn(forest); // one fawn per census — slow regrowth
    }
  }

  /**
   * The hunger loop that makes wolves feel alive: a pack whose forest has no
   * prey left starves, leaves the woods together, and prowls toward the
   * nearest village — chickens, villagers and travellers beware — until fed
   * or footsore, then slinks home.
   */
  private tickWolfPacks(host: WorldSimHost, now: number): void {
    if (now < this.nextWolfCheckAt) return;
    this.nextWolfCheckAt = now + WOLF_CHECK_MS;

    // One pass: gather the packs (camp wolves with drives).
    const packs = new Map<number, Entity[]>();
    for (const e of this.zone.entities.values()) {
      if (e.dead || e.kind !== 'monster' || e.campId === undefined || !e.ai?.drives) continue;
      let pack = packs.get(e.campId);
      if (!pack) packs.set(e.campId, (pack = []));
      pack.push(e);
    }

    for (const [campId, pack] of packs) {
      const camp = this.world.camps.find((c) => c.id === campId);
      if (!camp || camp.regionId === undefined) continue;
      const den = tileCenter(camp.cx, camp.cy);
      const roamUntil = this.roamingPacks.get(campId);

      if (roamUntil === undefined) {
        // Home in the forest. Does starvation drive the pack out?
        const starving = pack.some((w) => (w.ai!.drives!.hunger ?? 0) >= 0.85);
        if (!starving) continue;

        // March on the nearest village's outskirts (that's where food is).
        let village = this.world.villages[0];
        let best = Infinity;
        for (const v of this.world.villages) {
          const vc = tileCenter(v.cx, v.cy);
          const d = dist(den.x, den.y, vc.x, vc.y);
          if (d < best) {
            best = d;
            village = v;
          }
        }
        const vc = tileCenter(village.cx, village.cy);
        const len = Math.max(1, best);
        const edge = {
          x: vc.x + ((den.x - vc.x) / len) * (village.radius * TILE_SIZE + 8),
          y: vc.y + ((den.y - vc.y) / len) * (village.radius * TILE_SIZE + 8),
        };
        const until = now + EXCURSION_MS;
        for (const wolf of pack) {
          if ((wolf.ai!.drives!.hunger ?? 0) < 0.55) continue; // the sated stay behind
          const ai = wolf.ai!;
          ai.roamUntil = until;
          ai.home = { x: edge.x + this.rng.range(-4, 4), y: edge.y + this.rng.range(-4, 4) };
          ai.wanderRadius = 12;
          ai.mode = 'wander';
          ai.path = [{ x: edge.x, y: edge.y }];
          ai.targetId = undefined;
        }
        this.roamingPacks.set(campId, until);
        const forest = this.world.regions.find((r) => r.id === camp.regionId);
        host.systemNotice(
          `🐺 Gaunt wolves have come down from ${forest?.name ?? 'the deep woods'} — they were seen loping toward ${village.name}!`
        );
        continue;
      }

      // Out roaming. Head home once fed — or once the excursion runs its course.
      const fed = pack.every((w) => (w.ai!.drives!.hunger ?? 0) < 0.45);
      if (!fed && now < roamUntil) continue;
      for (const wolf of pack) {
        const ai = wolf.ai!;
        if (!ai.roamUntil) continue;
        ai.roamUntil = undefined;
        ai.home = { x: den.x + this.rng.range(-3, 3), y: den.y + this.rng.range(-3, 3) };
        ai.wanderRadius = 5;
        ai.mode = 'return';
        ai.path = [{ x: den.x, y: den.y }];
        ai.targetId = undefined;
      }
      this.roamingPacks.delete(campId);
      if (fed) {
        const forest = this.world.regions.find((r) => r.id === camp.regionId);
        host.systemNotice(`The wolves, sated, slink back into ${forest?.name ?? 'the woods'}.`);
      }
    }

    // A pack wiped out while roaming leaves a stale entry; clear it.
    for (const [campId, until] of this.roamingPacks) {
      if (!packs.has(campId) && now > until) this.roamingPacks.delete(campId);
    }
  }

  /**
   * The event director: keeps something happening every ~15–25s — travelers on
   * the roads, monster packs prowling the wilds, ambient flavor and rare omens —
   * so the overworld never feels dead.
   */
  private runEvents(host: WorldSimHost, now: number): void {
    if (now < this.nextEventAt) return;
    this.nextEventAt = now + EVENT_INTERVAL_MS + this.rng.range(0, 8_000);
    const roll = this.rng.next();
    if (roll < 0.42) {
      host.systemNotice(this.rng.pick(WILD_FLAVOR));
    } else if (roll < 0.7) {
      this.spawnTraveler(host, now);
    } else if (roll < 0.92) {
      this.spawnWildPack(host, now);
    } else {
      host.systemNotice(this.rng.pick(OMENS));
    }
  }

  /** A lone traveler walks a road between two villages, then fades from the world. */
  private spawnTraveler(host: WorldSimHost, now: number): void {
    if (this.world.roads.length === 0) return;
    const road = this.rng.pick(this.world.roads);
    const forward = this.rng.chance(0.5);
    const path = forward ? [...road.points] : [...road.points].reverse();
    const to = this.world.villages.find((v) => v.id === (forward ? road.b : road.a));
    const start = path[0];
    const title = this.rng.pick(TRAVELER_TITLES);
    const t = spawnNpc(this.zone, 'villager', start.x, start.y, { name: title, path });
    if (t.ai) t.ai.mode = 'travel'; // follow the road like a caravan
    t.despawnAt = now + 150_000; // self-clean if it never reaches town
    host.systemNotice(`You spot ${title} on the road${to ? ` to ${to.name}` : ''}.`);
  }

  /** A roaming monster pack prowls the wilds for a while, then wanders off. */
  private spawnWildPack(host: WorldSimHost, now: number): void {
    const kinds = ['goblin', 'wolf', 'orc'] as const;
    const kind = this.rng.pick(kinds);
    const c = tileCenter(this.rng.int(20, this.world.map.w - 20), this.rng.int(20, this.world.map.h - 20));
    const spot = this.openSpot(c.x, c.y, 8);
    const n = this.rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const m = spawnMonster(this.zone, MONSTERS[kind], spot.x + this.rng.range(-3, 3), spot.y + this.rng.range(-3, 3));
      if (m.ai) m.ai.wanderRadius = 12;
      m.despawnAt = now + 150_000; // the pack moves on if left alone
    }
    host.systemNotice(`A pack of ${MONSTERS[kind].name}s has been sighted prowling the wilds.`);
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
      const raiders: Entity[] = [];
      for (const m of this.zone.entities.values()) {
        if (m.kind === 'monster' && m.campId === camp.id && !m.dead && m.ai) {
          raiders.push(m);
          if (raiders.length >= 3) break;
        }
      }
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
    // Dismiss the escort (deleting the current entry mid-iteration is safe).
    for (const e of this.zone.entities.values()) {
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
