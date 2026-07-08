# WebMagic

A browser MMO dungeon crawler in the visual style of Doom and classic first-person
dungeon crawlers — real 3D (three.js), chunky pixels, billboard sprites, and
reactive torch light. Set in a living fantasy world where villagers wander,
caravans haul goods between villages, guards fight off monster raids, and glowing
portals lead to procedurally generated multiplayer dungeons.

![stack](https://img.shields.io/badge/stack-TypeScript%20·%20three.js%20·%20ws%20·%20Vite-blue)

## Quick start

```bash
npm install
npm run dev        # game server (ws://localhost:8080) + client (http://localhost:5173)
```

Open http://localhost:5173, pick a name and a class, and walk out of the inn.
Open a second browser tab to meet yourself in the world.

| Script | What it does |
| --- | --- |
| `npm run dev` | server (port 8080) + client with hot reload |
| `npm run dev:server` / `npm run dev:client` | each side alone |
| `npm run build` | production client bundle (`packages/client/dist`) |
| `npm run start` | build the client, then serve the whole game on **port 80** |
| `npm run typecheck` | strict TS across all packages |

### Production: one process on the normal http port

`npm start` builds the client and starts the game server, which serves the client
as static files **and** the game WebSocket (`/ws`) on the same port — **80** by
default, so the game is simply `http://your-host/`. Override with `PORT=…`.

Binding port 80 on Linux needs privileges — either run as root, or grant node the
capability once:

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"
```

(For HTTPS put a reverse proxy like Caddy or nginx in front and forward `/` and
`/ws` to this server; the client automatically uses `wss:` on https pages.)

**Controls:** WASD move · mouse (pointer lock) or arrow keys turn · left click / `1`-`2`
skills · `E` interact · `I` inventory & character sheet · `Enter` chat (`/l ` prefix = local chat).

**Server env:** `PORT` (default 80; dev script uses 8080), `WORLD_SEED` (a new seed
is a whole new world), `DATA_DIR`, `CLIENT_DIST`, `MAX_CONNECTIONS`, `DEV_COMMANDS=0`
to disable the `/goto` and `/xp` dev commands.

## What's in the game right now

- **Three classes** — Warrior, Wizard, Knight — each with a passive, a primary attack
  and an unlockable second skill (Whirlwind, Frost Nova, Holy Light), levels, XP and
  attribute growth.
- **Generated equipment** — five slots, five rarities (common → legendary), affix
  system with generated names ("Savage Warhammer of the Bear"). Loot drops from
  monsters and dungeon floors; click to equip, stats recompute server-side.
- **A living overworld** — 4 villages with wandering villagers and patrolling guards,
  8 monster camps that repopulate, caravans that periodically set out along the roads
  with escorts (and sometimes get ambushed — the world announces it), and a full
  day/night cycle where monsters get bolder after dark.
- **Multiplayer dungeons** — 4 overworld portals lead to procedurally generated
  dungeons with infinite floors of scaling difficulty. Everyone entering the same
  portal joins the same instance, forming ad-hoc groups. Loot found inside is
  *unclaimed* until you complete 2 floors and leave through an exit portal; die down
  there and you wake up at the inn having lost everything you found.
- **Doom-style rendering** — low-res upscaled framebuffer, billboard pixel sprites lit
  by the scene, merged tile geometry, fog, and a pooled dynamic light system: torches
  flicker, firebolts light up corridors as they fly, explode on impact with a real
  flash of light and splash damage, portals glow, rare loot shines. Walls use
  procedurally generated PBR stone materials (color + normal + roughness maps), and
  the overworld runs a full day/night cycle with a travelling sun, moonlight, a
  starfield and an in-game clock.
- **Resilience** — the public HTTP surface survives malformed requests, the tick loop
  and process are guarded against stray exceptions, and the client reconnects and
  logs back in automatically if the connection drops.
- **Chat** — global and local (earshot) channels plus world event announcements.
- **Persistence** — characters (level, XP, inventory, equipment, position) survive
  server restarts.

## Architecture

npm workspaces monorepo, TypeScript everywhere, strict mode:

```
packages/
  shared/   protocol, math/RNG, tile maps, collision, content defs, world+dungeon generators
  server/   authoritative simulation: zones, AOI replication, AI, combat, dungeons, persistence
  client/   three.js renderer, prediction/interpolation, procedural art, HUD/UI
```

### The key design decisions

**Deterministic shared generation.** World and dungeon maps are generated from a
seed by code in `shared/` (`gen/worldgen.ts`, `gen/dungeongen.ts`) with a seeded
RNG — the server never sends tile data, only `{seed, floor}`. The client rebuilds
the identical map locally. This keeps zone transfers at a few bytes and guarantees
client prediction collides against exactly the same walls the server does
(`shared/collision.ts` is used verbatim on both sides).

**Zones are the unit of simulation.** A `Zone` (server) is one self-contained space —
the overworld or a single dungeon floor — owning its entities and a spatial hash grid
(`SpatialGrid`). Nothing in a zone touches sockets; replication lives in `GameServer`.
This is the seam for horizontal scaling: zones can move to worker threads or separate
processes without touching game logic.

**Interest management.** Every snapshot (10 Hz), each client receives only entities
within its area of interest (44 m radius, spatial-grid query) plus an enter/leave
diff (`gone` list). Per-player bandwidth is bounded by local density, not world
population. Simulation ticks at 20 Hz; AI target scans are staggered (~300 ms).

**Server-authoritative movement with client prediction.** The client applies input
locally (instant feel), sends ≤60 ms input chunks, and the server integrates,
clamps speed and resolves collision. Snapshots carry the last processed input
sequence; the client rebases to the authoritative position and replays unacked
inputs, easing micro-corrections and snapping on teleports. Remote entities render
130 ms in the past, interpolated between snapshots.

**The protocol is a seam.** All messages are typed unions in `shared/protocol.ts`
behind `encode`/`decode` — currently JSON for debuggability; a binary codec can be
swapped in without touching game code.

**The world simulation is just entities.** Villagers, guards, caravans and monsters
are ordinary AI entities (`server/game/ai.ts` state machines: wander, chase, flee,
travel, escort) plus a `WorldSim` director that spawns caravans, schedules camp
respawns and runs the clock. Player-visible drama (caravan ambushes, guard deaths)
is emergent from factions + aggro, not scripted.

**Dungeon lifecycle.** `DungeonManager` keeps one open instance per portal; floors
generate lazily on first visit; the instance is disposed when the last player
leaves. Death/loot rules are enforced server-side via per-item `dungeonLoot` flags
(`Player.loseDungeonLoot` / `secureDungeonLoot`).

**Persistence is an interface.** `PlayerStore` (`server/src/persist/store.ts`) ships
with a JSON file implementation; swap in Postgres/Redis behind the same four methods.

**All art is procedural.** `client/src/render/textures.ts` draws every texture and
sprite into canvases at boot. Replacing them with real pixel art is a pure content
task — the renderer only sees `THREE.Texture`s.

### Server layout

```
server/src/
  index.ts            ws endpoint, rate limiting, lifecycle
  config.ts           env-driven config
  net/session.ts      per-socket state, token buckets, AOI bookkeeping
  game/game.ts        GameServer: tick loop, replication, message handling, dungeon flow
  game/zone.ts        Zone: entities + spatial grid + projectiles/regen/damage funnel
  game/spatial.ts     spatial hash grid (AOI queries)
  game/entities.ts    entity data + snapshot encoding
  game/player.ts      stats/level/inventory/equipment/dungeon-run state
  game/combat.ts      skill execution, projectiles
  game/ai.ts          NPC/monster state machines
  game/worldsim.ts    living-world director (caravans, respawns, day/night)
  game/dungeon.ts     instance + floor management
  game/spawn.ts       entity factories
  persist/store.ts    PlayerStore interface + JSON impl
```

### Client layout

```
client/src/
  main.ts             boot, login, message routing, game loop
  net.ts              websocket wrapper (same-origin /ws, proxied by Vite)
  input.ts            pointer lock, WASD/arrows, action callbacks
  state.ts            zone model, entity interpolation, prediction + reconciliation
  render/renderer.ts  scene, camera, day/night atmosphere, low-res pixelated output
  render/level.ts     merged tile geometry (floors, walls, ceilings, trees)
  render/lights.ts    pooled point lights: torches, lantern, projectiles, portals
  render/sprites.ts   billboard entities with hit-flash/death poses
  render/fx.ts        floating combat text, nova rings
  render/textures.ts  procedural textures + pixel sprites
  ui/                 login, HUD (orbs/skills/minimap/death screen), chat, inventory
```

## Scaling path (by design, not yet built)

The base is a single Node process, comfortably handling hundreds of connections
thanks to AOI. The prepared seams for "massive":

1. **Shard zones across workers/processes** — zones already own their state and
   communicate with the network layer through one interface.
2. **Binary protocol + delta compression** — swap `encode`/`decode`.
3. **Real auth + DB store** — replace the name-claim handshake and `JsonFileStore`.
4. **Gateway tier** — sessions are already decoupled from simulation, so a
   websocket gateway can front multiple zone servers.

## Roadmap ideas

- Parties, trading, PvP flags; name plates over players
- More skills per class + skill ranks; consumables and gold
- 8-directional sprites, real pixel-art set, sound
- Village reputation/economy driven by caravan survival
- Boss floors with mechanics; leaderboards for deepest dive
- Roofed interiors, doors that open, destructibles

## Dev commands (in chat, enabled by default — `DEV_COMMANDS=0` to disable)

```
/goto portal 0     teleport to a dungeon portal (0-3)
/goto village 1    teleport to a village inn
/xp 500            grant XP
```
