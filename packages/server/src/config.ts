export const CONFIG = {
  /** HTTP + WebSocket port. 80 = the normal http port (needs privileges on Linux). */
  port: Number(process.env.PORT ?? 80),
  /** Where the built client lives; served as static files on the same port. */
  clientDist: process.env.CLIENT_DIST ?? new URL('../../client/dist', import.meta.url).pathname,
  /** Seed for the persistent overworld. Change it and a whole new world is born. */
  worldSeed: Number(process.env.WORLD_SEED ?? 1337),
  motd: 'Welcome to WebMagic. The lanterns are lit — try not to die in the dark.',
  /** Where player data is persisted (JSON file store; swap for a DB in production). */
  dataDir: process.env.DATA_DIR ?? new URL('../data', import.meta.url).pathname,
  saveIntervalMs: 60_000,
  /** Hard cap on concurrent connections for this single node. */
  maxConnections: Number(process.env.MAX_CONNECTIONS ?? 500),
  /** Messages allowed per second per connection before we drop them. */
  messageRateLimit: 80,
  /** Dev chat commands (/goto, /xp). Disable for real deployments. */
  devCommands: process.env.DEV_COMMANDS !== '0',
  /** Length of a full in-game day in ms (override to fast-forward for testing). */
  dayLengthMs: Number(process.env.DAY_LENGTH_MS ?? 10 * 60 * 1000),
};
