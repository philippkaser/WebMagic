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
Open a second browser tab to meet yourself in the world. Set a passphrase on the
login screen to protect your hero — it's remembered on this browser so you log
straight back into the same character next visit (see **Accounts** below).

| Script | What it does |
| --- | --- |
| `npm run dev` | server (port 8080) + client with hot reload |
| `npm run dev:server` / `npm run dev:client` | each side alone |
| `npm run build` | production client bundle (`packages/client/dist`) |
| `npm run start` | build the client, then serve the whole game on **port 80** |
| `npm run typecheck` | strict TS across all packages |
| `npm test` | run the unit test suite (Node's built-in runner) |
| `npm run test:watch` | same, re-running on file changes |
| `npm run check` | typecheck **and** test — what CI runs |

### Testing

Tests use Node's built-in test runner (`node:test`) with `tsx` for TypeScript —
**no Jest/Vitest, no build step, no extra heavyweight tooling**. A test is just a
`*.test.ts` file next to the code it covers; `npm test` discovers them by glob and
the whole suite runs in under a second. The focus is the pure, deterministic core
in `shared/` — the seeded RNG, tile collision, world/dungeon generation, item rolls
and stat derivation — because that code is where correctness matters most and is
trivial to test without standing up a server. GitHub Actions runs `npm run check`
on every push and PR (`.github/workflows/ci.yml`).

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

**Controls:** WASD move · **`Shift` sprint** (drains stamina) · **`Space` jump** ·
mouse (pointer lock) free-look in every direction, or arrow keys turn · left click / `1`-`2`
skills · `E` interact · `I` inventory & character sheet · `Enter` chat (`/l ` prefix = local chat).

Jump feels different per class: the **Knight** holds `Space` to charge a crouch and
releases for a big leap, the **Wizard** taps `Space` again in the air to hover, and the
**Warrior** gets a mid-air double jump.

**Server env:** `PORT` (default 80; dev script uses 8080), `WORLD_SEED` (a new seed
is a whole new world), `DATA_DIR`, `CLIENT_DIST`, `MAX_CONNECTIONS`, `DEV_COMMANDS=0`
to disable the `/goto` and `/xp` dev commands.

## What's in the game right now

- **Movement with feel** — sprint with a stamina budget, free-look mouse camera, and a
  jump whose flavor depends on your class (Knight charge-jump, Warrior double-jump,
  and a Wizard who catches the air to **glide a long way on a slow fall, trailing
  purple arcane motes and light**). Vertical motion and stamina run through one shared physics module
  (`shared/movement.ts`) simulated identically on client and server, so your own jumps
  feel instant and other players see them too.
- **Three classes** — Warrior, Wizard, Knight — each with a passive, a primary attack
  and an unlockable second skill (Whirlwind, Frost Nova, Holy Light), levels, XP and
  attribute growth.
- **Generated equipment** — five slots, five rarities (common → legendary), affix
  system with generated names ("Savage Warhammer of the Bear"). Loot drops from
  monsters and dungeon floors; click to equip, stats recompute server-side. **Any
  class can wield any weapon**, and the weapon defines your left- and right-click
  skills (a staff casts firebolt/frost-nova, a sword slashes/whirlwinds…) while your
  class skills sit on E/Q. Rarer weapons roll an always-on **passive** — *Wisplight*
  (a wisp of light orbits you), *Cinder Orbit* (fireballs circle and scorch nearby
  foes), *Vampiric* (lifesteal), *Spiteful* (thorns), *Rimeheart* (a slowing frost
  aura); legendaries always have one. **Deeper dungeon floors drop higher item levels
  and rarer gear**, so diving pays off.
- **A living overworld** — villagers follow real daily routines: they work around the
  village square by day (stopping to chat with each other), gather at the inn in the
  evening and walk home through their front doors to sleep at night — and they talk to
  passing players in local chat. Guards walk patrol circuits (perimeter by day, pulled
  in around the torches at night), caravans set out along the roads with escorts by
  daylight only (and sometimes get ambushed), monster camps repopulate, wolves are
  nocturnal hunters that doze through the day, and at night camps send raiding parties
  marching on the nearest village — guards fight them off while villagers flee.
- **Multiplayer dungeons** — 4 overworld portals lead to procedurally generated
  dungeons with infinite floors of scaling difficulty. Everyone entering the same
  portal joins the same instance, forming ad-hoc groups. Loot found inside is
  *unclaimed* until you complete 2 floors and leave through an exit portal; die down
  there and you wake up at the inn having lost everything you found. Floors are
  stalked by skeletons, imps, ogres, fast **cave spiders**, and **gelatinous slimes
  that split into two slimelets when you cut them down** — and studded with **spike
  traps** that bite grounded heroes, so time a jump to cross them unharmed.
- **Doom-style rendering** — low-res upscaled framebuffer, billboard pixel sprites lit
  by the scene (humanoids are **4-directional** — front/back/side views chosen from
  their facing relative to the camera — drawn at higher resolution with two-tone
  shading, and recoloured per-entity so crowds of villagers, guards and monsters
  vary), **vertical terrain** — a per-tile height field (deterministic in the shared
  map) gives the wilds rolling inclines and raises some dungeon chambers a step, with
  floors, walls, trees, sprites and the camera all riding the elevation; settlements
  and roads stay flat — merged tile geometry, fog, and a pooled
  dynamic light system: torches
  flicker, firebolts light up corridors as they fly, explode on impact with a real
  flash of light and splash damage, portals glow, rare loot shines. Walls use
  real stone artwork (`client/public/textures/stone-wall.jpg`) turned into full PBR
  materials at load — normal and roughness maps are derived from the image, with
  tinted variants for house masonry and rock and a procedural fallback. The
  **ground is PBR too**: grass tufts, plank grooves, flagstone joints, packed-dirt
  roads, rippling glossy water and glowing portal runes are each baked from a
  procedural height field into colour + normal + roughness maps, so floors catch
  torch- and sunlight with real relief. Water surfaces are **animated** — their
  colour and ripple-normal maps scroll so the surface flows. The overworld runs a full day/night cycle
  with a travelling sun, moonlight, a starfield and an in-game clock. A pooled
  particle system throws embers from fireball blasts and hits, kicks up dust
  when a jump lands, rises embers off nearby torch flames and swirls motes around
  portal mouths. Dungeon corridors are lit by sconces at intervals so passages
  aren't pitch black, and torch flames are drawn at higher resolution. Combat and movement have **game feel**: a trauma-based screen
  shake, springy camera kicks (a recoil punch on casts, a downward dip on landings,
  an FOV punch on nearby blasts) and a red damage vignette when you're struck.
- **Resilience** — the public HTTP surface survives malformed requests, the tick loop
  and process are guarded against stray exceptions, and the client reconnects and
  logs back in automatically if the connection drops.
- **Chat** — global and local (earshot) channels plus world event announcements.
- **Persistence** — characters (level, XP, inventory, equipment, position) survive
  server restarts.
- **Accounts** — log back into your previous character instead of making a new one
  each time. The client remembers your name and class on this browser and pre-fills
  the login screen. Set a passphrase to protect a name (scrypt-hashed server-side,
  `salt:hash`, never stored in plaintext) so only you can log in as that hero; leave
  it blank for an open name, as before. Existing characters stay open until the first
  passphrase claims them.

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
