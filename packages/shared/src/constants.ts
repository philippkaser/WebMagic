export const PROTOCOL_VERSION = 3;

/** Server simulation rate. */
export const TICK_MS = 50; // 20 Hz
/** A snapshot is broadcast every N ticks. */
export const SNAPSHOT_EVERY = 2; // 10 Hz

/** Area-of-interest radius: entities within this range are replicated, in meters. */
export const AOI_RADIUS = 44;

export const PLAYER_RADIUS = 0.42;
export const PICKUP_RADIUS = 1.1;
export const INTERACT_RANGE = 2.6;

export const INVENTORY_SIZE = 24;

export const CHAT_LOCAL_RADIUS = 40;
export const CHAT_MAX_LENGTH = 240;

/** Full day/night cycle length in ms of real time. */
export const DAY_LENGTH_MS = 10 * 60 * 1000;

/** How long dropped loot stays on the ground. */
export const LOOT_TTL_MS = 90 * 1000;

export const MAX_NAME_LENGTH = 16;
