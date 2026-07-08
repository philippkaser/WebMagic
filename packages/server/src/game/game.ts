import {
  AOI_RADIUS,
  CHAT_LOCAL_RADIUS,
  CHAT_MAX_LENGTH,
  CLASSES,
  ClientMessage,
  DUNGEON_KEEP_FLOORS,
  EntitySnapshot,
  FxMsg,
  INTERACT_RANGE,
  MAX_NAME_LENGTH,
  PICKUP_RADIUS,
  PROTOCOL_VERSION,
  PortalDef,
  Rng,
  TILE_SIZE,
  SNAPSHOT_EVERY,
  SkillId,
  STAMINA_MAX,
  TICK_MS,
  isCharging,
  jumpPress,
  jumpRelease,
  speedMultiplier,
  stepStamina,
  stepVertical,
  Tile,
  VillageDef,
  ZoneMsg,
  dist,
  generateItem,
  generateOverworld,
  worldToTile,
  xpForLevel,
} from '@webmagic/shared';
import { CONFIG } from '../config';
import { Session } from '../net/session';
import { Entity, snapshotEntity } from './entities';
import { Zone } from './zone';
import { Player, PlayerRecord } from './player';
import { WorldSim } from './worldsim';
import { DungeonManager } from './dungeon';
import { tickAi, AiHost } from './ai';
import { castSkill } from './combat';
import { dropLoot } from './spawn';
import type { PlayerStore } from '../persist/store';
import { hashPassphrase, verifyPassphrase } from '../auth';

export class GameServer implements AiHost {
  readonly sessions = new Set<Session>();
  private readonly store: PlayerStore;

  private overworld!: Zone;
  private worldSim!: WorldSim;
  private dungeons = new DungeonManager(CONFIG.worldSeed);
  private zoneMeta = new Map<string, Omit<ZoneMsg, 't' | 'x' | 'y'>>();
  private villages: VillageDef[] = [];
  private portalsById = new Map<number, PortalDef>();

  private tickCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lootRng = new Rng((Date.now() & 0xffffff) ^ 0xbeef);

  constructor(store: PlayerStore) {
    this.store = store;
  }

  now(): number {
    return Date.now();
  }

  // -------------------------------------------------------------- lifecycle

  start(): void {
    const world = generateOverworld(CONFIG.worldSeed);
    this.villages = world.villages;
    for (const p of world.portals) this.portalsById.set(p.id, p);

    this.overworld = new Zone('overworld', 'overworld', world.map, world.torches);
    this.zoneMeta.set('overworld', { zoneId: 'overworld', kind: 'overworld', seed: CONFIG.worldSeed });

    this.worldSim = new WorldSim(this.overworld, world, CONFIG.worldSeed, CONFIG.dayLengthMs);
    this.worldSim.populate(this.now());

    // A logic error in one tick must never take the server down.
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('[game] tick error (survived):', err);
      }
    }, TICK_MS);
    setInterval(() => void this.store.flush(), CONFIG.saveIntervalMs);
    console.log(
      `[game] world ${world.map.w}x${world.map.h} ready — ` +
        `${world.villages.length} villages, ${world.camps.length} camps, ${world.portals.length} portals, ` +
        `${this.overworld.entities.size} entities`
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions) {
      if (s.player) await this.store.save(s.player.toRecord());
    }
    await this.store.flush();
  }

  private activeZones(): Zone[] {
    return [this.overworld, ...this.dungeons.allZones()];
  }

  private zoneById(id: string): Zone | null {
    if (id === 'overworld') return this.overworld;
    return this.dungeons.allZones().find((z) => z.id === id) ?? null;
  }

  // ------------------------------------------------------------------ tick

  private tick(): void {
    const dt = TICK_MS / 1000;
    const now = this.now();
    this.tickCount++;

    const clock = {
      time: this.worldSim.worldTime(now),
      isNight: this.worldSim.isNight(now),
      aggroMul: this.worldSim.monsterAggroMultiplier(now),
    };
    const dungeonClock = { time: 0.5, isNight: false, aggroMul: 1 };
    for (const zone of this.activeZones()) {
      tickAi(this, zone, dt, zone.kind === 'overworld' ? clock : dungeonClock);
      zone.tick(this, dt);
      this.tickPlayers(zone, now);
    }
    this.worldSim.tick(this);

    // Dispose empty dungeon instances.
    if (this.tickCount % 40 === 0) this.dungeons.reap();

    if (this.tickCount % SNAPSHOT_EVERY === 0) this.broadcastSnapshots(now);
  }

  private tickPlayers(zone: Zone, now: number): void {
    const dt = TICK_MS / 1000;
    for (const player of [...zone.players]) {
      const ent = player.entity;
      if (ent.dead) {
        ent.z = 0;
        continue;
      }

      // Jump physics + sprint stamina (shared with client prediction).
      stepVertical(player.vert, player.classId, now, dt);
      ent.z = player.vert.z;
      const sprinting = player.sprintHeld && ent.anim === 'move';
      player.stamina = stepStamina(player.stamina, sprinting, dt);

      if (zone.kind === 'overworld') {
        player.lastOverworld = { x: ent.x, y: ent.y };
      }

      // Walk-over loot pickup.
      for (const e of zone.grid.query(ent.x, ent.y, PICKUP_RADIUS)) {
        if (e.kind !== 'loot' || !e.item) continue;
        const item = e.item;
        if (zone.kind === 'dungeon') item.dungeonLoot = true;
        if (player.addItem(item)) {
          zone.removeEntity(e);
          this.sendInventory(player);
          this.notify(player, `Picked up ${item.name} (${item.rarity}).`, 'loot');
          this.broadcastFx(zone, { t: 'fx', kind: 'pickup', x: e.x, y: e.y });
        }
      }

      // Stairs: descend to the next dungeon floor.
      if (zone.kind === 'dungeon' && player.dungeonRun) {
        const tile = zone.map.get(worldToTile(ent.x), worldToTile(ent.y));
        if (tile === Tile.StairsDown) this.descendStairs(player, now);
      }
    }
  }

  // ---------------------------------------------------------- replication

  private broadcastSnapshots(now: number): void {
    const time = this.worldSim.worldTime(now);
    for (const session of this.sessions) {
      const player = session.player;
      if (!player) continue;
      const zone = this.zoneById(player.zoneId);
      if (!zone) continue;

      if (session.needsZoneSync) {
        session.needsZoneSync = false;
        session.known.clear();
        const meta = this.zoneMeta.get(zone.id)!;
        session.send({ t: 'zone', ...meta, x: player.entity.x, y: player.entity.y });
      }

      const ent = player.entity;
      const visible = zone.grid.query(ent.x, ent.y, AOI_RADIUS);
      const ents: EntitySnapshot[] = [];
      const currentIds = new Set<number>();
      for (const e of visible) {
        if (e.id === ent.id) continue;
        currentIds.add(e.id);
        ents.push(snapshotEntity(e));
      }
      const gone: number[] = [];
      for (const id of session.known) {
        if (!currentIds.has(id)) gone.push(id);
      }
      session.known = currentIds;

      const cds: Partial<Record<SkillId, number>> = {};
      for (const skill of player.unlockedSkills()) {
        const rem = player.cooldownRemaining(skill, now);
        if (rem > 0) cds[skill] = Math.round(rem);
      }

      session.send({
        t: 'snap',
        tick: this.tickCount,
        time,
        self: {
          x: ent.x,
          y: ent.y,
          ack: player.lastInputSeq,
          spd: player.stats.moveSpeed * (ent.slowUntil && ent.slowUntil > now ? 0.5 : 1),
          hp: Math.ceil(ent.hp),
          mp: Math.floor(player.mp),
          maxHp: player.stats.maxHp,
          maxMp: player.stats.maxMp,
          level: player.level,
          xp: Math.floor(player.xp),
          xpNext: xpForLevel(player.level),
          cds,
          dead: ent.dead,
          floorsDone: player.dungeonRun?.floorsDone,
          slowUntil: ent.slowUntil && ent.slowUntil > now ? ent.slowUntil - now : undefined,
          stam: Math.round(player.stamina),
          maxStam: STAMINA_MAX,
        },
        ents,
        gone,
      });
    }
  }

  broadcastFx(zone: Zone, fx: FxMsg): void {
    for (const session of this.sessions) {
      const p = session.player;
      if (!p || p.zoneId !== zone.id) continue;
      if (dist(p.entity.x, p.entity.y, fx.x, fx.y) > AOI_RADIUS + 10) continue;
      session.send(fx);
    }
  }

  systemNotice(text: string): void {
    for (const session of this.sessions) {
      if (session.player) session.send({ t: 'chat', ch: 'system', from: 'World', text });
    }
  }

  private notify(player: Player, text: string, style?: string): void {
    this.sessionOf(player)?.send({ t: 'notice', text, style });
  }

  private sessionOf(player: Player): Session | null {
    for (const s of this.sessions) if (s.player === player) return s;
    return null;
  }

  playerByEntityId(id: number): Player | undefined {
    for (const s of this.sessions) {
      if (s.player?.entity.id === id) return s.player;
    }
    return undefined;
  }

  private sendInventory(player: Player): void {
    this.sessionOf(player)?.send({
      t: 'inv',
      items: player.inventory,
      equipment: player.equipment,
      attrs: player.attrs,
    });
  }

  // -------------------------------------------------------------- combat cb

  onEntityKilled(zone: Zone, victim: Entity, killer: Entity | null): void {
    const now = this.now();
    this.broadcastFx(zone, { t: 'fx', kind: 'death', x: victim.x, y: victim.y, entId: victim.id });

    if (victim.kind === 'player') {
      const player = this.playerByEntityId(victim.id);
      if (player) this.onPlayerDied(player, zone);
      return;
    }

    // XP + loot credit goes to the last player who hit.
    const creditId = killer?.kind === 'player' ? killer.id : victim.lastHitBy;
    const player = creditId ? this.playerByEntityId(creditId) : undefined;
    if (victim.kind === 'monster' && victim.monsterDef) {
      const def = victim.monsterDef;
      if (player) {
        const gained = player.addXp(def.xp);
        if (gained > 0) {
          this.broadcastFx(zone, { t: 'fx', kind: 'levelup', x: player.entity.x, y: player.entity.y, entId: player.entity.id });
          this.notify(player, `Level up! You are now level ${player.level}.`, 'info');
          this.sendInventory(player); // attrs changed
        }
      }
      if (Math.random() < def.lootChance) {
        const item = generateItem(this.lootRng, Math.max(1, def.level * 2));
        dropLoot(zone, victim.x, victim.y, item, now);
      }
      if (zone.kind === 'dungeon') {
        // dungeons do not respawn — clear the corpse after a moment
        victim.despawnAt = now + 4000;
      }
    }
    if (zone.kind === 'overworld') this.worldSim.onEntityKilled(this, victim);
    else if (victim.kind === 'npc') victim.despawnAt = now + 4000;
  }

  onCaravanArrived(zone: Zone, caravan: Entity): void {
    this.worldSim.onCaravanArrived(this, caravan);
  }

  npcSay(zone: Zone, speaker: Entity, text: string): void {
    for (const session of this.sessions) {
      const p = session.player;
      if (!p || p.zoneId !== zone.id) continue;
      if (dist(p.entity.x, p.entity.y, speaker.x, speaker.y) > CHAT_LOCAL_RADIUS) continue;
      session.send({ t: 'chat', ch: 'local', from: speaker.name ?? 'Villager', text });
    }
  }

  private onPlayerDied(player: Player, zone: Zone): void {
    if (zone.kind === 'dungeon') {
      const lost = player.loseDungeonLoot();
      this.notify(
        player,
        lost > 0
          ? `You died in the dark… ${lost} unclaimed item${lost === 1 ? '' : 's'} lost to the dungeon.`
          : 'You died in the dark…',
        'warn'
      );
    } else {
      this.notify(player, 'You died. The innkeeper drags you to a bed.', 'warn');
    }
  }

  // ------------------------------------------------------------- messages

  handleMessage(session: Session, msg: ClientMessage): void {
    if (msg.t === 'hello') {
      void this.handleHello(session, msg.name, msg.classId, msg.v, msg.pass);
      return;
    }
    const player = session.player;
    if (!player) return;

    switch (msg.t) {
      case 'input':
        this.handleInput(player, msg.seq, msg.mx, msg.my, msg.f, msg.dt, msg.sprint === true);
        break;
      case 'jump':
        if (!player.entity.dead) {
          if (msg.phase === 'down') jumpPress(player.vert, player.classId, this.now());
          else jumpRelease(player.vert, player.classId, this.now());
        }
        break;
      case 'cast': {
        const zone = this.zoneById(player.zoneId);
        if (!zone) return;
        const err = castSkill(this, zone, player, msg.skillId, msg.aim, this.now());
        if (err) this.notify(player, err, 'warn');
        break;
      }
      case 'chat':
        this.handleChat(session, msg.ch, msg.text);
        break;
      case 'interact':
        this.handleInteract(player, msg.id);
        break;
      case 'equip':
        if (player.equip(msg.itemId)) this.sendInventory(player);
        break;
      case 'unequip':
        if (player.unequip(msg.slot)) this.sendInventory(player);
        break;
      case 'drop': {
        const zone = this.zoneById(player.zoneId);
        const item = player.removeItem(msg.itemId);
        if (item && zone) {
          dropLoot(zone, player.entity.x, player.entity.y, item, this.now());
          this.sendInventory(player);
        }
        break;
      }
      case 'respawn':
        this.handleRespawn(player);
        break;
      case 'ping':
        session.send({ t: 'pong', time: msg.time });
        break;
    }
  }

  private async handleHello(
    session: Session,
    rawName: string,
    classId: string,
    version: number,
    rawPass?: string
  ): Promise<void> {
    if (session.player) return;
    if (version !== PROTOCOL_VERSION) {
      session.send({ t: 'reject', reason: 'Client is outdated — refresh the page.' });
      return;
    }
    const name = String(rawName ?? '').trim();
    if (!/^[A-Za-z0-9_]{2,}$/.test(name) || name.length > MAX_NAME_LENGTH) {
      session.send({ t: 'reject', reason: 'Names are 2-16 letters, digits or underscores.' });
      return;
    }
    if (!(classId in CLASSES)) {
      session.send({ t: 'reject', reason: 'Unknown class.' });
      return;
    }
    const passphrase = typeof rawPass === 'string' ? rawPass : '';
    if (passphrase && (passphrase.length < 4 || passphrase.length > 64)) {
      session.send({ t: 'reject', reason: 'Passphrase must be 4-64 characters.' });
      return;
    }
    for (const s of this.sessions) {
      if (s.player && s.player.name.toLowerCase() === name.toLowerCase()) {
        session.send({ t: 'reject', reason: 'That hero is already in the world.' });
        return;
      }
    }

    let record = await this.store.load(name);
    let claimedPassHash: string | undefined;
    if (record) {
      // Existing character. If it's protected, the passphrase must match.
      if (record.passHash) {
        if (!verifyPassphrase(passphrase, record.passHash)) {
          session.send({
            t: 'reject',
            reason: passphrase ? 'Wrong passphrase for that hero.' : 'That hero is protected — enter its passphrase.',
          });
          return;
        }
      } else if (passphrase) {
        // Previously-open character: the first passphrase claims and protects it.
        claimedPassHash = hashPassphrase(passphrase);
      }
    } else {
      const spawn = this.villages[0]?.innSpawn ?? { x: 20, y: 20 };
      record = {
        name,
        classId: classId as PlayerRecord['classId'],
        level: 1,
        xp: 0,
        inventory: [],
        equipment: {},
        x: spawn.x,
        y: spawn.y,
        passHash: passphrase ? hashPassphrase(passphrase) : undefined,
      };
    }

    const player = new Player(record);
    if (claimedPassHash) player.passHash = claimedPassHash;
    session.player = player;
    // Characters that logged out inside a dungeon come back at the inn.
    if (this.overworld.map.blockedAtWorld(player.entity.x, player.entity.y)) {
      const spawn = this.villages[0]?.innSpawn ?? { x: 20, y: 20 };
      player.entity.x = spawn.x;
      player.entity.y = spawn.y;
    }
    player.lastOverworld = { x: player.entity.x, y: player.entity.y };
    this.overworld.addEntity(player.entity);
    this.overworld.players.add(player);
    player.zoneId = 'overworld';
    session.needsZoneSync = true;

    // Persist immediately so new characters and freshly-claimed passphrases
    // survive a crash before the player disconnects.
    await this.store.save(player.toRecord());

    session.send({ t: 'welcome', playerId: player.entity.id, name: player.name, classId: player.classId, motd: CONFIG.motd });
    this.sendInventory(player);
    this.systemNotice(`${player.name} the ${CLASSES[player.classId].name} entered the world.`);
    console.log(`[game] ${player.name} (${player.classId}) connected — ${this.sessions.size} online`);
  }

  private handleInput(
    player: Player,
    seq: number,
    mx: number,
    my: number,
    facing: number,
    dtMs: number,
    sprint: boolean
  ): void {
    const ent = player.entity;
    player.lastInputSeq = seq;
    player.sprintHeld = sprint;
    if (ent.dead) return;

    // Sanitize: clamp dt and direction magnitude (basic speed-hack defense).
    const dt = Math.min(Math.max(dtMs, 0), 60) / 1000;
    let len = Math.sqrt(mx * mx + my * my);
    if (len > 1) {
      mx /= len;
      my /= len;
      len = 1;
    }
    ent.facing = Number.isFinite(facing) ? facing : ent.facing;

    if (len > 0.01) {
      const now = this.now();
      const slowed = ent.slowUntil && now < ent.slowUntil ? 0.5 : 1;
      const stunned = ent.stunUntil && now < ent.stunUntil;
      if (!stunned) {
        const zone = this.zoneById(player.zoneId);
        if (zone) {
          const gamefeel = speedMultiplier(sprint, player.stamina, isCharging(player.vert));
          const speed = player.stats.moveSpeed * slowed * gamefeel;
          zone.moveEntity(ent, mx * speed * dt, my * speed * dt);
          ent.anim = 'move';
        }
      }
    } else if (ent.anim === 'move') {
      ent.anim = 'idle';
    }
  }

  private handleChat(session: Session, ch: string, rawText: string): void {
    const player = session.player!;
    if (!session.takeChatToken()) {
      this.notify(player, 'You are chatting too fast.', 'warn');
      return;
    }
    const text = String(rawText ?? '').slice(0, CHAT_MAX_LENGTH).trim();
    if (!text) return;

    if (text.startsWith('/')) {
      this.handleCommand(player, text);
      return;
    }

    if (ch === 'global') {
      for (const s of this.sessions) {
        if (s.player) s.send({ t: 'chat', ch: 'global', from: player.name, text });
      }
    } else {
      // local: same zone, within earshot
      for (const s of this.sessions) {
        const p = s.player;
        if (!p || p.zoneId !== player.zoneId) continue;
        if (dist(p.entity.x, p.entity.y, player.entity.x, player.entity.y) > CHAT_LOCAL_RADIUS) continue;
        s.send({ t: 'chat', ch: 'local', from: player.name, text });
      }
    }
  }

  /** Dev-only chat commands — see CONFIG.devCommands. */
  private handleCommand(player: Player, text: string): void {
    if (!CONFIG.devCommands) {
      this.notify(player, 'Commands are disabled on this server.', 'warn');
      return;
    }
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case 'goto': {
        if (player.zoneId !== 'overworld') {
          this.notify(player, '/goto only works in the overworld.', 'warn');
          return;
        }
        const idx = Number(args[1] ?? 0);
        let dest: { x: number; y: number } | null = null;
        if (args[0] === 'portal') {
          const p = this.portalsById.get(idx);
          if (p) dest = { x: (p.tx + 0.5) * TILE_SIZE, y: (p.ty + 1.5) * TILE_SIZE };
        } else if (args[0] === 'village') {
          const v = this.villages[idx];
          if (v) dest = v.innSpawn;
        }
        if (!dest) {
          this.notify(player, 'Usage: /goto portal|village [index]', 'warn');
          return;
        }
        this.teleport(player, dest.x, dest.y);
        this.notify(player, `Whoosh — ${args[0]} ${idx}.`, 'info');
        break;
      }
      case 'xp': {
        const amount = Math.max(0, Math.min(100000, Number(args[0] ?? 100)));
        const gained = player.addXp(amount);
        this.notify(player, `+${amount} XP${gained ? ` — level ${player.level}!` : ''}`, 'info');
        this.sendInventory(player);
        break;
      }
      default:
        this.notify(player, 'Commands: /goto portal|village [i], /xp <amount>', 'info');
    }
  }

  private teleport(player: Player, x: number, y: number): void {
    const zone = this.zoneById(player.zoneId);
    if (!zone) return;
    player.entity.x = x;
    player.entity.y = y;
    zone.grid.update(player.entity);
  }

  private handleInteract(player: Player, targetId: number): void {
    const zone = this.zoneById(player.zoneId);
    if (!zone || player.entity.dead) return;
    const target = zone.entities.get(targetId);
    if (!target) return;
    if (dist(player.entity.x, player.entity.y, target.x, target.y) > INTERACT_RANGE + target.radius) return;

    if (target.kind === 'portal') {
      if (target.portalRole === 'dungeon-entrance') this.enterDungeon(player, target.portalId!);
      else if (target.portalRole === 'dungeon-exit') this.exitDungeon(player);
      return;
    }
    if (target.kind === 'loot' && target.item) {
      const item = target.item;
      if (zone.kind === 'dungeon') item.dungeonLoot = true;
      if (player.addItem(item)) {
        zone.removeEntity(target);
        this.sendInventory(player);
        this.notify(player, `Picked up ${item.name} (${item.rarity}).`, 'loot');
      } else {
        this.notify(player, 'Your bags are full.', 'warn');
      }
      return;
    }
    if (target.kind === 'npc' && target.variant === 'villager') {
      const lines = [
        'Stay on the roads after dark, stranger.',
        'The caravans keep us alive. Guard them if you can.',
        'They say the portals lead to halls full of treasure… and teeth.',
        'The guards can only do so much. We are glad you are here.',
      ];
      this.notify(player, `${target.name ?? 'Villager'}: "${lines[Math.floor(Math.random() * lines.length)]}"`, 'info');
    }
  }

  // -------------------------------------------------------------- dungeons

  private moveToZone(player: Player, zone: Zone, x: number, y: number): void {
    const from = this.zoneById(player.zoneId);
    if (from) {
      from.removeEntity(player.entity);
      from.players.delete(player);
    }
    player.entity.x = x;
    player.entity.y = y;
    player.zoneId = zone.id;
    zone.addEntity(player.entity);
    zone.players.add(player);
    const session = this.sessionOf(player);
    if (session) session.needsZoneSync = true;

    if (!this.zoneMeta.has(zone.id)) {
      // dungeon zone meta is registered on floor creation; this is a safety net
      this.zoneMeta.set(zone.id, { zoneId: zone.id, kind: zone.kind, seed: 0 });
    }
  }

  private enterDungeon(player: Player, portalId: number): void {
    const portal = this.portalsById.get(portalId);
    if (!portal) return;
    const inst = this.dungeons.enter(portal);
    const { zone, data } = inst.getFloor(0, this.now());
    this.zoneMeta.set(zone.id, {
      zoneId: zone.id,
      kind: 'dungeon',
      seed: inst.seed,
      floor: 0,
      dungeonName: portal.name,
      keepFloors: DUNGEON_KEEP_FLOORS,
    });
    player.dungeonRun = { dungeonId: inst.key, portalId, floor: 0, floorsDone: 0 };
    this.moveToZone(player, zone, data.spawn.x, data.spawn.y);
    this.notify(player, `You step into ${portal.name}. Complete ${DUNGEON_KEEP_FLOORS} floors to claim what you find.`, 'info');
  }

  private descendStairs(player: Player, now: number): void {
    const run = player.dungeonRun;
    if (!run) return;
    const inst = this.dungeons.instanceByZoneId(player.zoneId);
    if (!inst) return;
    run.floor++;
    run.floorsDone++;
    const { zone, data } = inst.getFloor(run.floor, now);
    this.zoneMeta.set(zone.id, {
      zoneId: zone.id,
      kind: 'dungeon',
      seed: inst.seed,
      floor: run.floor,
      dungeonName: this.portalsById.get(run.portalId)?.name,
      keepFloors: DUNGEON_KEEP_FLOORS,
    });
    this.moveToZone(player, zone, data.spawn.x, data.spawn.y);
    if (run.floorsDone === DUNGEON_KEEP_FLOORS) {
      this.notify(player, `Floor ${run.floor} — your loot is now yours to keep if you make it out alive!`, 'loot');
    } else {
      this.notify(player, `You descend to floor ${run.floor}. The air grows colder.`, 'info');
    }
  }

  private exitDungeon(player: Player): void {
    const run = player.dungeonRun;
    if (!run) return;
    const portal = this.portalsById.get(run.portalId);
    if (run.floorsDone >= DUNGEON_KEEP_FLOORS) {
      player.secureDungeonLoot();
      this.notify(player, 'You emerge into the open air, treasure in hand.', 'loot');
    } else {
      const lost = player.loseDungeonLoot();
      this.notify(
        player,
        lost > 0
          ? `You fled before completing ${DUNGEON_KEEP_FLOORS} floors — ${lost} item${lost === 1 ? '' : 's'} crumble to dust.`
          : 'You flee the dungeon empty-handed.',
        'warn'
      );
    }
    player.dungeonRun = null;
    const exitPos = portal
      ? { x: (portal.tx + 0.5) * TILE_SIZE, y: (portal.ty + 2) * TILE_SIZE }
      : player.lastOverworld;
    this.moveToZone(player, this.overworld, exitPos.x, exitPos.y);
    this.sendInventory(player);
  }

  private handleRespawn(player: Player): void {
    if (!player.entity.dead) return;
    // Wake up at the inn of the nearest village.
    const ref = player.lastOverworld;
    let best = this.villages[0];
    let bestD = Infinity;
    for (const v of this.villages) {
      const d = dist(ref.x, ref.y, v.innSpawn.x, v.innSpawn.y);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    player.dungeonRun = null;
    player.entity.dead = false;
    player.entity.anim = 'idle';
    player.recompute();
    player.entity.hp = player.stats.maxHp;
    player.mp = player.stats.maxMp;
    this.moveToZone(player, this.overworld, best.innSpawn.x, best.innSpawn.y);
    this.sendInventory(player);
    this.notify(player, `You wake up at the inn of ${best.name}.`, 'info');
  }

  // ------------------------------------------------------------ connection

  addSession(session: Session): void {
    this.sessions.add(session);
  }

  async removeSession(session: Session): Promise<void> {
    this.sessions.delete(session);
    const player = session.player;
    if (!player) return;
    session.player = null;

    const zone = this.zoneById(player.zoneId);
    if (zone) {
      zone.removeEntity(player.entity);
      zone.players.delete(player);
    }
    // Logging out mid-dungeon counts as fleeing without the loot.
    if (player.dungeonRun) {
      player.loseDungeonLoot();
      player.entity.x = player.lastOverworld.x;
      player.entity.y = player.lastOverworld.y;
    }
    await this.store.save(player.toRecord());
    this.systemNotice(`${player.name} left the world.`);
    console.log(`[game] ${player.name} disconnected — ${this.sessions.size} online`);
  }
}
