import type { ClassId } from './content/classes';
import type { SkillId } from './content/skills';
import type { Item, Slot } from './content/items';
import type { Attributes } from './content/stats';

/**
 * Wire protocol. JSON for the base implementation; message shapes are kept
 * flat and compact so a binary encoder (e.g. flatbuffers) can be swapped in
 * behind `encode`/`decode` later without touching game code.
 */

// ---------------------------------------------------------------------------
// Entities as replicated to clients

export type EntityKind = 'player' | 'npc' | 'monster' | 'projectile' | 'loot' | 'portal';

/** Animation / high-level state, replicated for client-side presentation. */
export type EntityAnim = 'idle' | 'move' | 'attack' | 'cast' | 'dead';

export interface EntitySnapshot {
  id: number;
  k: EntityKind;
  /** Variant/sprite id: class id for players, monster id, npc role, rarity for loot… */
  v: string;
  x: number;
  y: number;
  /** Facing angle, radians. */
  f: number;
  hp: number;
  mhp: number;
  a: EntityAnim;
  /** Display name (players, named npcs, portals). */
  n?: string;
  lvl?: number;
  /** Emitted light color as 0xRRGGBB — drives reactive lighting client-side. */
  lt?: number;
  /** Height above the ground in meters (jumping). Omitted when on the ground. */
  z?: number;
}

// ---------------------------------------------------------------------------
// Client -> Server

export type ChatChannel = 'global' | 'local' | 'system';

export interface HelloMsg {
  t: 'hello';
  v: number; // protocol version
  name: string;
  classId: ClassId;
  /** Optional account passphrase. Protects a name; blank/absent = open name. */
  pass?: string;
}

export interface InputMsg {
  t: 'input';
  seq: number;
  /** Normalized movement direction in world space (server clamps magnitude). */
  mx: number;
  my: number;
  /** Facing angle, radians. */
  f: number;
  /** Client frame delta in ms (server clamps). */
  dt: number;
  /** Sprint held this chunk (drains stamina, faster move). */
  sprint?: boolean;
}

export interface JumpMsg {
  t: 'jump';
  /** Key edge: 'down' on press (jump/charge/hover), 'up' on release. */
  phase: 'down' | 'up';
}

export interface CastMsg {
  t: 'cast';
  skillId: SkillId;
  /** Aim direction for projectiles, radians. */
  aim: number;
}

export interface ChatMsg {
  t: 'chat';
  ch: ChatChannel;
  text: string;
}

export interface InteractMsg {
  t: 'interact';
  /** Target entity id (portal, npc…). */
  id: number;
}

export interface EquipMsg {
  t: 'equip';
  itemId: string;
}

export interface UnequipMsg {
  t: 'unequip';
  slot: Slot;
}

export interface DropItemMsg {
  t: 'drop';
  itemId: string;
}

export interface RespawnMsg {
  t: 'respawn';
}

export interface PingMsg {
  t: 'ping';
  time: number;
}

export type ClientMessage =
  | HelloMsg
  | InputMsg
  | JumpMsg
  | CastMsg
  | ChatMsg
  | InteractMsg
  | EquipMsg
  | UnequipMsg
  | DropItemMsg
  | RespawnMsg
  | PingMsg;

// ---------------------------------------------------------------------------
// Server -> Client

export interface WelcomeMsg {
  t: 'welcome';
  playerId: number;
  name: string;
  classId: ClassId;
  motd: string;
}

export interface RejectMsg {
  t: 'reject';
  reason: string;
}

/** Sent when the player enters a zone. The client regenerates the map from the seed. */
export interface ZoneMsg {
  t: 'zone';
  zoneId: string;
  kind: 'overworld' | 'dungeon';
  seed: number;
  floor?: number;
  dungeonName?: string;
  /** Floors needed before the exit portal keeps your loot. */
  keepFloors?: number;
  x: number; // spawn position
  y: number;
}

export interface SelfState {
  x: number;
  y: number;
  /** Last processed input sequence — client rewinds+replays prediction from here. */
  ack: number;
  /** Current move speed (m/s) so client prediction matches the server exactly. */
  spd: number;
  hp: number;
  mp: number;
  maxHp: number;
  maxMp: number;
  level: number;
  xp: number;
  xpNext: number;
  /** ms remaining per skill on cooldown. */
  cds: Partial<Record<SkillId, number>>;
  dead: boolean;
  /** Dungeon progress (floors completed in current run). */
  floorsDone?: number;
  slowUntil?: number;
  /** Sprint stamina, 0..maxStam. */
  stam: number;
  maxStam: number;
}

export interface SnapshotMsg {
  t: 'snap';
  tick: number;
  /** Server world time 0..1 (0 = midnight, 0.5 = noon) for day/night lighting. */
  time: number;
  self: SelfState;
  ents: EntitySnapshot[];
  /** Entity ids that left the area of interest. */
  gone: number[];
}

export interface InventoryMsg {
  t: 'inv';
  items: Item[];
  equipment: Partial<Record<Slot, Item>>;
  attrs: Attributes;
  /** Active skill loadout: [left-click, right-click, E, Q]; null = empty slot. */
  loadout: (SkillId | null)[];
}

export interface ChatBroadcastMsg {
  t: 'chat';
  ch: ChatChannel;
  from: string;
  text: string;
}

/** Transient effects: floating damage numbers, level-ups, deaths, pickups… */
export interface FxMsg {
  t: 'fx';
  kind:
    | 'hit' | 'crit' | 'heal' | 'death' | 'levelup' | 'pickup' | 'nova' | 'explosion' | 'feathers'
    /** An attack being wound up — the telegraph before the blow (amount = windup ms). */
    | 'windup'
    /** A melee swing arc (dir = aim angle, amount = range). */
    | 'swing';
  x: number;
  y: number;
  entId?: number;
  amount?: number;
  color?: number;
  text?: string;
  /** Direction in radians (swing arcs). */
  dir?: number;
}

export interface NoticeMsg {
  t: 'notice';
  text: string;
  /** 'info' | 'warn' | 'loot' — client styles accordingly. */
  style?: string;
}

export interface PongMsg {
  t: 'pong';
  time: number;
}

export type ServerMessage =
  | WelcomeMsg
  | RejectMsg
  | ZoneMsg
  | SnapshotMsg
  | InventoryMsg
  | ChatBroadcastMsg
  | FxMsg
  | NoticeMsg
  | PongMsg;

// ---------------------------------------------------------------------------
// Encoding — single seam for a future binary protocol.

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
