# WebMagic — Architecture Review

*Modularity · future-proofing · performance at scale*

This review walks the whole codebase (shared, server, client) and grades it against
three questions: **is it modular**, **is it future-proof** for the planned direction
(varied world generation, a deep life sim, a higher-fidelity art style, revamped
combat feel), and **does it guarantee performance for a large number of players**.
Findings reference concrete files and lines; the final section is a prioritized
roadmap.

**TL;DR**

| Axis | Grade | One-liner |
| --- | --- | --- |
| Modularity | **B+** | Excellent seams (zones, protocol, store, deterministic gen). Two god-modules are forming: `game.ts` and `ai.ts`. |
| Future-proofing | **B** | The seams line up well with the planned features, but the life sim and worldgen goals need two new subsystems (needs-driven AI, chunked/biome gen) that don't exist yet. |
| Performance at scale | **C+** | AOI + spatial hashing bound bandwidth correctly, but several O(sessions) and O(entities) hot paths turn quadratic under load, and everything runs on one thread with no backpressure story past ~a few hundred players. |

---

## 1. Modularity

### 1.1 What's genuinely good

- **The package split is real, not cosmetic.** `shared/` holds only pure,
  deterministic code (math/RNG, tiles, collision, movement physics, content defs,
  world/dungeon generators) and is exercised by fast unit tests. `server/` and
  `client/` both consume it verbatim — client prediction collides against exactly
  the walls the server does (`shared/collision.ts`, `shared/movement.ts`).
- **Deterministic shared generation is the single best architectural decision in
  the codebase.** Zone transfer is `{seed, floor}` (`protocol.ts` `ZoneMsg`); the
  client rebuilds the identical map. This scales to any world size without
  touching the wire format and makes worldgen changes purely a `shared/` concern.
- **Zones are a clean unit of simulation.** `Zone` (`server/src/game/zone.ts`) owns
  entities + spatial grid and talks to the rest of the server only through the
  `ZoneHost` interface — no sockets, no globals. This is the honest sharding seam
  the README claims it is.
- **The protocol is a seam.** Typed unions behind `encode`/`decode`
  (`shared/src/protocol.ts:251`) — a binary codec swap is genuinely contained.
- **Persistence is an interface** (`PlayerStore`, `server/src/persist/store.ts`) with
  four methods. A Postgres/Redis swap doesn't touch game code.
- **Rendering is decoupled from art.** The renderer consumes `THREE.Texture`s only;
  every sprite and texture is produced in one place (`client/src/render/textures.ts`).
- **Game feel is shared physics.** Jump/stamina/sprint live in `shared/movement.ts`
  and run identically on both sides — the right foundation for "smoother game feel."

### 1.2 Where modularity is eroding

**`GameServer` is becoming a god object** (`server/src/game/game.ts`, ~900 lines).
It currently owns: the tick loop, replication, session bookkeeping, login/auth flow,
chat + dev commands, loot pickup, spike traps, weapon passives, XP/kill credit,
slime splitting, every interaction (`handleInteract` is a growing `if`-chain on
variant strings — signpost, campfire, chicken, shrine, obelisk…), dungeon
enter/descend/exit, respawn, and teleport. Each new feature lands here. Before the
gameplay push, split it along its existing comment banners:

- `replication.ts` — snapshots, AOI diffing, fx/chat fan-out
- `interactions.ts` — a registry: `Map<variant, (host, player, target) => void>`
  instead of the `if`-chain, so new world objects (doors, chests, NPC dialogue)
  are one registration each
- `login.ts` — hello/auth/name-claim flow
- `commands.ts` — chat commands
- keep `game.ts` as the thin composition root + tick loop

**`ai.ts` is a variant-switch, not a behavior system** (`server/src/game/ai.ts:67`).
`tickAi` dispatches on `variant` strings to hand-rolled per-role tick functions, and
`AiState` (`entities.ts:39`) is a grab-bag of every role's fields (villager routine,
guard patrol rings, caravan paths, chat partners, stuck detection…). It works at
today's six behaviors, but it is the module the life-sim vision will break first —
see §2.2.

**`Entity` is one struct with optional everything** (`server/src/game/entities.ts:72`):
player, monster, projectile, loot, and portal fields all live side by side. At the
current entity count this is pragmatic and cache-friendly; but each new system
(hunger, NPC inventories, faction goals) adds more optional fields that every
consumer must null-check. You don't need a full ECS, but grouping into typed
sub-objects (`e.combat`, `e.ai`, `e.proj` — `ai` already works this way) keeps it
honest.

**Content is code, not data.** Monsters/items/skills/passives are TS constant maps
in `shared/src/content/`. Type-safe and fine for now — but "a more varied world not
limited by current grinds" implies lots more content; consider keeping the TS types
and loading the *instances* from JSON/YAML so content iteration doesn't mean
touching engine code.

**Minor:** message handling trusts decoded JSON shapes. `decode` is a blind
`JSON.parse` cast (`protocol.ts:255`); `handleInput` sanitizes carefully, but other
handlers index maps with unvalidated fields. A tiny per-message-type validator (or
zod at the seam) closes the class of bugs before scale amplifies it.

---

## 2. Future-proofing against the planned direction

### 2.1 Varied world generation — *foundation good, needs a biome + chunk layer*

What exists (`shared/src/gen/worldgen.ts`): a single 240×240 dense `TileMap`
(`Uint8Array` tiles + heights), single-pass blob scatter (forest/rock/water),
rejection-sampled villages/camps/portals/POIs, jittered roads, two-octave elevation
noise. It reads clearly and is well tested (`gen.test.ts`).

What blocks a "much more interesting, varied" world:

1. **There is one implicit biome.** Everything is grass-with-features. There's no
   temperature/moisture (or similar) field driving *regional* character — no dark
   forest region, marsh, highlands, badlands. Trees are scattered blobs, not
   forests with identity — which also matters for the life sim ("wolves live in
   *the woods*"): **forests are not first-class objects**, just tiles, so nothing
   can reason about "the forest" as a home region.
2. **The map is monolithic.** `TileMap` is a fixed dense array generated at boot;
   the client builds the entire level mesh in one shot (`render/level.ts`). Fine at
   240×240; a 1000×1000+ world needs *chunked* generation (deterministic per-chunk
   from `hash(seed, cx, cy)` — the RNG utilities already support this) and chunked
   client meshing with distance-based build/dispose.
3. **POI variety is hardcoded lists.** A small grammar (weighted templates with
   placement constraints) would let content grow without touching the generator.

**Verdict:** the deterministic-seed architecture is exactly right for this goal and
nothing needs throwing away. The work is: add a region/biome pass (noise → biome id
per tile, stored beside `heights`), make named regions (forest #3, marsh #1)
queryable data in `OverworldData`, and chunk both generation and client meshing.
Do the biome pass *before* authoring more content — content wants to be per-biome.

### 2.2 The life sim — *the biggest architectural gap*

The vision (wolves living in woods, hunting deer, hunger driving them out to roam
villages and return; goblins/humans/caravans with their own goals; everything
interacting) is an **agent simulation with needs, homes, and memory**. What exists
is a reactive FSM per variant: scan → chase → attack → leash home, plus villager
clock-routines and one-shot event-director spawns (`worldsim.ts`). Predation exists
(`scanForPrey`) but is reactive proximity, not motivated behavior.

Missing pieces, in dependency order:

1. **A needs/drives layer.** Give AI entities a small vector of drives (hunger,
   rest, fear, duty) that accumulate over time and are satisfied by actions. Wolf:
   hunger ↑ slowly → below threshold it hunts prey *in its home region*; if hunger
   crosses "starving" and the region has no prey, it widens its search radius
   beyond the forest — that is *exactly* the requested "wolves leave the woods"
   emergent story, and it falls out of two numbers plus region data. Utility
   scoring (pick highest-scoring drive, hysteresis to avoid flip-flopping) beats
   both bare FSMs and heavyweight behavior trees here.
2. **Home regions as data** (depends on worldgen §2.1): each creature belongs to a
   region (forest, camp, village); "return home" becomes "return to region", and
   region population counts let the sim reason about prey scarcity cheaply.
3. **Simulation LOD — this is also the #1 scale risk.** Today *every* entity ticks
   full AI every 50 ms whether or not any player is within a kilometer
   (`tickAi` iterates all of `zone.entities`). A big living world multiplies entity
   count by 10–50×; full-rate ticking will not survive that. Introduce tiers:
   - **Near** (within any player's AOI + margin): full AI at 20 Hz — unchanged.
   - **Far**: think at 0.5–1 Hz, move by teleport-along-path, skip target scans.
   - **Abstract** (nothing loaded nearby): pure bookkeeping — "wolf pack #4:
     hunger 0.7, position drifts along path" — materialized into real entities
     when a player approaches.
   The spatial grid already answers "any player nearby?" cheaply. This single
   change is what makes "incredible life sim" and "large player count" compatible.
4. **Faction goals** for goblins/caravans/humans are 80% present already (factions,
   aggro, escort, raids in `worldsim.ts`); they become dramatically richer once
   they sit on drives + regions instead of timers.

**Verdict:** nothing in the current design *prevents* this — `Zone`/`AiHost`
boundaries are right — but plan it as a new `server/src/game/sim/` subsystem
(drives, regions, LOD scheduler) that the per-variant behaviors plug into, not as
more fields on `AiState`.

### 2.3 Art style — *cleanest upgrade path in the project*

- **Sprites:** all art is procedurally drawn at boot into canvases
  (`textures.ts`, 1,535 lines — by far the largest file in the repo). Because the
  renderer only consumes `THREE.Texture`, moving to authored higher-res pixel art
  is a pure content swap: add an atlas loader that resolves `spriteDef(variant)`
  from PNG sheets, keep the procedural generator as fallback. The 4-directional
  facing system in `sprites.ts` carries over unchanged; 8-directional is a
  `spriteDef` change, not a renderer change.
- **3D models for some objects:** `EntitySprites` is billboard-only today, but the
  wall/PBR work (`stone-wall.jpg` → derived normal/roughness) proves the pipeline
  handles real assets. Add a per-variant render-kind registry
  (`billboard | mesh`), load GLTFs for props/fixtures (barrels, shrines,
  portals) — contained inside `render/`.
- **Rustic Doom-era look:** already the house style (low-res framebuffer,
  `PIXEL_SCALE = 3`, ACES tone mapping, fog, torch lighting). Cheap wins that push
  it further: color-count quantization pass on generated textures, dithered fog,
  and a palette-constrained light response.
- **Splash screen + login** (`ui/login.ts`, 122 lines): deliberately minimal DOM
  and easily replaced. The auth *protocol* (scrypt-hashed passphrase name-claim)
  is sound for the game's trust level; a nicer flow (splash → character list →
  create/select) is UI work plus one protocol message (`list characters for this
  browser token`). Two server-side notes for when accounts matter more:
  `scryptSync` blocks the event loop on every login (switch to async `scrypt`),
  and `handleHello` is `async` with the duplicate-name check *before* the first
  `await` — two simultaneous hellos for the same name can both pass; re-check
  after the awaited `store.load`.

### 2.4 Combat feel — *client seams ready, server hits are too abstract*

The client side is genuinely strong already: trauma-based screen shake, springy
pitch/FOV/landing spring kicks (`renderer.ts:375`), pooled lights with real
explosion flashes, pooled particles, floating combat text, shared-physics jumps.
The `FxMsg` union is the right seam for richer effects — adding `kind` values is
backwards-cheap.

What limits "better gameplay/vfx, impact from attacks":

1. **Hits are instantaneous state changes.** `castSkill` applies damage the same
   tick (`combat.ts:85`); monsters attack with no wind-up (`ai.ts` `tryAttack`).
   There is no anticipation → impact arc, which is most of "game feel." Add
   `windupMs` to attack defs: server sets `anim: 'attack'` + commit-time, resolves
   damage when it elapses; clients get telegraph time to animate.
2. **No knockback/hit-stop.** Non-projectile entities have no velocity — `Entity`
   has `vx/vy` only for projectiles. A tiny impulse field (decayed in
   `zone.tick`, moved through `moveWithCollision`) buys knockback, and pairing hits
   with brief attacker/victim `stunUntil` (already exists) gives hit-stop.
3. **Attack anims are one frame.** `EntityAnim` is a five-value enum; there's no
   anim timing on the wire. A `animStart` timestamp in `EntitySnapshot` lets the
   client run real multi-frame attack/hurt cycles once the sprite atlas (§2.3)
   provides frames.

None of this fights the architecture — it's additive on existing seams.

---

## 3. Performance for a large number of players

### 3.1 What's already right

- **Interest management is correct**: per-player snapshot cost is bounded by local
  density (spatial-grid AOI query, enter/leave diffs, 10 Hz snapshots vs 20 Hz sim).
- **Spatial hash** (`spatial.ts`) is clean O(1) insert/move with packed int keys.
- **Staggered AI thinking** (~250–300 ms `nextThink`) keeps target scans off the
  per-tick hot path.
- **Token-bucket rate limiting** per session + `maxPayload` + connection cap.
- **Tick loop is exception-guarded**; persistence is periodic + on disconnect.

### 3.2 Hot paths that go quadratic under load

Ranked by how soon they hurt. "n" = concurrent players, "E" = entities in a zone.

1. **`playerByEntityId` / `sessionOf` are O(n) linear scans over all sessions**
   (`game.ts:306-316`) — and they're called from the innermost combat paths:
   `zone.applyDamage` calls `playerByEntityId` up to three times per hit (armor,
   lifesteal, thorns — `zone.ts:164-195`), `notify`/`sendInventory` call
   `sessionOf` per event. Combat-heavy load ⇒ O(hits × n). **Fix is trivial:**
   maintain `Map<entityId, Player>` and a `player.session` backref, updated at
   login/logout. Do this first; it's ~30 lines.
2. **Every fx broadcast scans every session** (`broadcastFx`, `game.ts:287`; same
   pattern in `npcSay` and local chat). Every hit, heal, pickup, explosion anywhere
   in the world iterates all n sessions to find the ~few in range. With the life
   sim multiplying combat events (wolves hunting deer nobody is watching), this
   becomes O(events × n). **Fix:** zones already track `players` — iterate
   `zone.players` and use the spatial grid (players are in it) for the radius cut;
   with per-zone player sets this is O(players-in-zone) instead of O(n).
   Better: suppress fx entirely when no player's AOI covers the event —
   the LOD tiers from §2.2 give this for free.
3. **Per-tick array copies of whole entity sets.** `tickAi` (`ai.ts:69`),
   `tickProjectiles` (`zone.ts:77`), and `tickLifetimes` (`zone.ts:146`) each do
   `[...zone.entities.values()]` every 50 ms — three full copies of E entities,
   20×/s, pure GC churn. Others scan all entities for filtered subsets:
   caravan-guard dismissal and raid mustering (`worldsim.ts:409,470`). **Fix:**
   iterate the Map directly with a small deferred-removal list, and keep typed
   sub-collections (`zone.projectiles`, `zone.byCampId`) maintained on
   add/remove.
4. **Snapshot encoding does redundant work per viewer.**
   `broadcastSnapshots` calls `snapshotEntity(e)` once *per viewing session*
   (`game.ts:243`); with k players standing together each sees the other k, so a
   crowded village square costs O(k²) fresh snapshot objects + JSON per 100 ms.
   **Fix in two stages:** (a) memoize `snapshotEntity` per entity per snapshot
   round (one WeakMap or a `tick`-stamped cache field); (b) the prepared
   binary-codec swap plus dirty-field deltas (send full snapshot on AOI-enter,
   deltas after). Stage (a) is an afternoon; stage (b) is the real 5–10× bandwidth
   win and the protocol seam was built for it.
5. **`zoneById` does a linear `find` over all dungeon zones** (`game.ts:118`) and
   `dungeons.allZones()` rebuilds an array — called per message and per player per
   tick. Keep a `Map<zoneId, Zone>` registry updated on floor create/dispose.
6. **Persistence rewrites the whole world's players as one JSON string**
   (`store.ts:50`) every 60 s and at every disconnect, non-atomically
   (`writeFile` in place — a crash mid-write corrupts `players.json`; write to
   temp + `rename` at minimum). String-building the full array blocks the event
   loop once records reach tens of MB. Fine for hundreds of characters; swap to
   SQLite/Postgres behind the existing `PlayerStore` interface before it's
   thousands, and add per-record dirty tracking.
7. **No dead-connection reaping.** There's no ws ping/heartbeat; half-open sockets
   hold connection slots (against `maxConnections`) and stay in `sessions` until
   TCP gives up (minutes). Add a 30 s ping/terminate sweep.
8. **`scryptSync` on the connection path** (§2.3) — a login burst (server restart
   with auto-reconnecting clients — the client *does* auto-reconnect in a loop,
   `main.ts:193`) serializes CPU-bound hashing on the event loop. Use async
   `scrypt`, and consider jittering client reconnect delays.

### 3.3 The single-thread ceiling and the sharding story

Everything — all zones, all AI, all replication — runs in one `setInterval` on one
core. The README's scaling path (zones → workers, gateway tier) is *architecturally
honest*: `Zone` really doesn't touch sockets, and `ZoneHost` is narrow. But two
things quietly couple zones to the main thread today and are worth fixing early,
because they're cheap now and expensive later:

- `GameServer` reaches directly into `zone.entities` / `zone.players` in many
  places (loot pickup, stairs, raids). Funnel those through `Zone` methods so the
  zone's interface stays serializable.
- Cross-zone knowledge lives in `Player` objects shared by reference between
  `GameServer` and zones. Define the zone-transfer record (it's basically
  `PlayerRecord` + entity state) now — it's also exactly what a worker-thread
  handoff will serialize.

With the §3.2 fixes, one node should comfortably run ~300–500 concurrent players
(the current `maxConnections` default) with a rich overworld. Past that, in order:
binary+delta protocol (bandwidth is the first real wall), then dungeon instances to
`worker_threads` (they're born isolated — the easy 80% of sharding), then an
overworld split only if actually needed.

### 3.4 A note on measurement

There is no server-side telemetry: no tick-duration histogram, no per-system
timings, no entity/session counters. Before optimizing anything above, add a
20-line stats line (p50/p99 tick ms, entities, sessions, snapshot bytes/s) logged
every 30 s and a `/stats` dev command. Every scaling claim in this document should
be validated with a headless bot harness (connect N fake clients that walk and
fight — the protocol is JSON over ws, so this is ~100 lines) before and after each
change.

---

## 4. Prioritized roadmap

**Phase 0 — measure + de-quadratic (small, do immediately)**
1. Stats/telemetry line + headless bot load harness (§3.4).
2. `Map<entityId, Player>` + session backrefs; kill all linear session scans (§3.2.1).
3. Zone-scoped fx/chat fan-out (§3.2.2). Zone registry map (§3.2.5).
4. Stop per-tick entity-set copies; typed sub-collections (§3.2.3).
5. Atomic store writes; ws heartbeat; async scrypt (§3.2.6–8).

**Phase 1 — foundations for the vision (medium)**
6. Split `game.ts` (replication / interactions registry / login / commands) and
   define the sim subsystem boundary (§1.2).
7. Biome/region pass in worldgen; named regions in `OverworldData`; chunked
   generation + chunked client meshing (§2.1).
8. Simulation LOD tiers (near/far/abstract) (§2.2.3) — the keystone that lets the
   life sim and player scale coexist.
9. Snapshot memoization now; binary + delta protocol behind `encode`/`decode` when
   bandwidth measurements say so (§3.2.4).

**Phase 2 — the visible payoff (large, parallelizable once Phase 1 lands)**
10. Needs/drives AI on regions: wolves (hunger → hunt → roam → return), goblin camp
    goals, caravan economies (§2.2).
11. Sprite atlas pipeline (authored hi-res pixel art, 8 directions, anim frames) +
    GLTF props; keep procedural fallback (§2.3).
12. Combat feel: wind-ups/telegraphs, knockback impulses, hit-stop, anim timing on
    the wire, richer per-skill fx (§2.4).
13. Splash screen + character-select login flow (§2.3).

The through-line: **nothing here requires a rewrite.** The seams this codebase
already paid for (deterministic gen, zones, protocol envelope, store interface,
texture indirection) are the right ones — the work is filling in the two missing
subsystems (regions/biomes, drives/LOD) and paying down the hot-path debt before
entity and player counts multiply.
