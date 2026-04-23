# Screeps AI

A TypeScript Screeps AI focused on automated room management from RCL 1 through RCL 6+: bootstrapping a creep workforce, transitioning to a miner/hauler/link economy, expanding the base (extensions, towers, roads, storage, links, terminal, extractor), defending with towers and defenders, and mining minerals.

## Features

- **TypeScript** with strict mode, bundled by Rollup into a single `dist/main.js`.
- **ErrorMapper** to translate runtime errors back to TypeScript source lines.
- **Priority-based spawner** that maintains minimum creep counts per role and scales bodies to the room's `energyCapacityAvailable`.
- **Automated construction manager** that places extensions (stamp layout), towers, containers, storage, links, terminal, extractor, roads, and ramparts based on RCL.
- **Link network** (RCL 5+) — source links near miners transfer energy instantly to a storage link; hauler count auto-reduces for linked sources.
- **Defense stack** — threat-scored focus-fire for towers, automatic safe-mode activation on base-perimeter breach, and reactive `defender` creeps spawned by a dynamic spawn queue.
- **Load-balanced harvesting** that spreads creeps across available sources.
- **Memory optimisations** — lazy `RawMemory` segment wrapper, per-tick cache, and one-shot Memory shape init to keep the per-tick JSON parse cheap as persistent data grows.
- **CPU profiler** with exponential-moving-average samples per manager and per role, exposed via console globals `stats()` / `resetStats()`.
- **Soft traffic manager** — CostMatrix-based pathing avoids creep clusters (cost 15) and hard-blocks stationary miners (cost 255). Each creep paths and moves independently; the Screeps engine handles 2-way swaps natively. Stuck detection fallback after 3 ticks.
- **Creep state machine** — all roles use a lightweight FSM (`StateMachineDefinition`) with state persisted in `creep.memory.state` for in-game debugging.
- **Visual debugging overlay** (opt-in) drawing per-room RCL / energy / creep counts / source load / idle creep indicators / path visualizations via `RoomVisual`.

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
npm install
```

### Scripts

- `npm run build` — Bundles `src/` into `dist/main.js` (with source map).
- `npm run watch` — Rebuilds on file changes.
- `npm run deploy` — Bumps patch version, builds, and uploads to Screeps world servers.
- `npm run localdeploy` — Bumps patch version and builds only (no upload).
- `npm run lint` — Runs ESLint over `src/`.
- `npm run format` / `npm run format:check` — Prettier.
- `npm test` — Run all Vitest tests.
- `npm run test:watch` — Vitest in watch mode.
- `npm run test:coverage` — Run tests with V8 coverage report.

### Deploying

`npm run deploy` wraps `screeps-api upload --branch default dist/main.js`. Configure credentials per the `screeps-api` docs, or manually paste `dist/main.js` into the in-game editor.

## Project Structure

```
src/
  main.ts                 # Game loop entry; per-tick init, manager dispatch, segment flush
  managers/
    spawner.ts            # Dynamic spawn queue, miner/bootstrap economy switch
    room.ts               # Per-tick creep dispatch + dead-creep memory cleanup
    towers.ts             # Focus-fire attack / heal / repair with scaled wall targets
    construction.ts       # Places extensions, towers, containers, storage, links, terminal, extractor, roads, ramparts by RCL
    defense.ts            # Threat tracking, safe-mode activation, defender demand
    links.ts              # Link network: source links → storage/controller link transfers
    visuals.ts            # Opt-in RoomVisual overlays (gated by Memory.visuals)
  roles/
    Role.ts               # Role interface (run(creep))
    index.ts              # Role registry keyed by CreepRoleName
    harvester.ts          # Bootstrap economy energy delivery
    upgrader.ts           # Controller upgrader (container/storage or self-harvest)
    builder.ts            # Build sites, withdraw from logistics in miner economy
    repairer.ts           # Repair structures, withdraw from logistics in miner economy
    defender.ts
    miner.ts              # Static source miner (heavy WORK+CARRY, link-aware)
    hauler.ts             # Energy + mineral logistics (link/container → structures/storage)
    mineralMiner.ts       # Mineral extractor miner (RCL 6+)
  utils/
    body.ts               # buildBody(pattern, energy, maxRepeats)
    sources.ts            # findBestSource / harvestFromBestSource / withdrawFromLogistics
    roomPlanner.ts        # Room plan caching (sources, containers, links, minerals, miner assignments)
    threat.ts             # threatScore / pickPriorityTarget for hostile creeps
    stateMachine.ts       # Lightweight FSM engine (StateMachineDefinition, runStateMachine)
    movement.ts           # moveTo wrapper — stuck detection + PathFinder pathing
    trafficManager.ts     # CostMatrix builder, path computation, stationary tile tracking
    idle.ts               # Idle creep tracking, rally-to-storage, grey circle indicators
    ErrorMapper.ts        # Source-map aware error logging
    tickCache.ts          # Transient per-tick memoisation (cleared at loop start)
    segments.ts           # Lazy RawMemory.segments wrapper with dirty-flush
    memoryInit.ts         # One-shot Memory shape init per global reset
    profiler.ts           # profile(name, fn) + stats() / resetStats() console globals
  types.d.ts              # CreepRoleName, CreepMemory, Memory, RoomMemory, ProfilerSample
```

## Tick Loop

`main.ts` wraps a single `loop` in `ErrorMapper.wrapLoop` and, inside a `profile('main.loop', …)` span:

1. `initMemory()` — One-shot (per global reset) shape init for `Memory.creeps` / `Memory.rooms`, so hot-path code skips defensive `??= {}` branches.
2. `resetTickCache()` — Clears the transient per-tick memoisation map.
2b. `resetTraffic()` — Clears stationary creep set and visualization buffer.
2c. `resetIdle()` — Clears the idle creep set for fresh per-tick tracking.
3. `runDefense()` — Refreshes per-room threat state and activates safe mode if a hostile has breached the base perimeter. Runs first so the spawner and towers both see the same threat view.
4. `runSpawner()` — Walks the (dynamically built) spawn queue and issues one spawn per tick if a role is under its minimum.
5. `runLinks()` — Transfers energy from source links to storage/controller links. Runs before rooms so creeps see fresh link state.
6. `runRooms()` — Cleans `Memory.creeps` entries for dead creeps, then dispatches each living creep to its role handler. Roles register movement intents via `moveTo()` during this phase.
6b. `resolveTraffic()` — Draws path visualizations when `Memory.visuals` is enabled. Movement already happened during role execution via `executeMove()`.
7. `runTowers()` — All towers focus-fire the highest-threat hostile; otherwise heal wounded allies, then repair. Wall/rampart repair target scales with storage energy.
8. `runConstruction()` — Runs every 5 ticks. Places extensions, towers, containers, storage, terminal, extractor, links, roads, ramparts — gated by RCL.
9. `runVisuals()` — Opt-in `RoomVisual` overlay (no-op unless `Memory.visuals` is true). Includes idle creep indicators.
10. `flushSegments()` — Serialises any mutated `RawMemory.segments` entries and registers requested segments for the next tick.

Each of steps 3–9 is wrapped in `profile(...)` so per-manager CPU cost surfaces in `stats()`. Per-creep dispatch in step 6 is labelled `role.<roleName>` for per-role CPU tracking.

## Roles

All roles implement the `Role` interface (`run(creep: Creep): void`) in `src/roles/Role.ts` and use the FSM engine in `src/utils/stateMachine.ts`. Each role defines a `StateMachineDefinition` with named states; state is persisted in `creep.memory.state` so you can inspect what any creep is doing in-game. Each non-harvester role refills by calling `harvestFromBestSource` when empty, which picks the active source with the fewest nearby harvesters and breaks ties by distance (`src/utils/sources.ts`).

| Role           | Minimum | Body pattern        | Behavior |
|----------------|---------|---------------------|----------|
| `miner`        | 1/source (miner economy) | `[WORK×2, CARRY, MOVE]` ×3 | Sits on a container adjacent to its assigned source and harvests indefinitely. Transfers energy to adjacent link if available (requires CARRY). |
| `hauler`       | 2-3/source unlinked, 1 total linked | `[CARRY×2, MOVE×2]` | Empties storage link (priority), then source containers, delivers to spawn/extensions/towers/controller container/storage. Picks up minerals from mineral container. |
| `harvester`    | 2 (bootstrap) / 1 (miner economy) | `[WORK, CARRY, MOVE]` | Self-harvests then delivers energy to spawn/extension/tower. Acts as emergency bootstrap when all miners die. |
| `upgrader`     | 2 (bootstrap) / 1–6 (miner economy) | Bootstrap: `[WORK, CARRY, MOVE]`; Miner: `[WORK×2, CARRY, MOVE]` ×4 | In miner economy: withdraws from controller container or storage, camps at controller (range 3). Count scales with storage surplus. |
| `builder`      | 1–3 (by site count) | Bootstrap: `[WORK, CARRY, MOVE]`; Miner: `[WORK, CARRY, MOVE×2]` ×4 | Builds construction sites, falls back to upgrading when idle. In miner economy: withdraws from containers/storage via `withdrawFromLogistics()`. |
| `repairer`     | 1–2 (by damage) | `[WORK, CARRY, MOVE]` | Repairs structures below 75% HP (excluding walls), falls back to upgrading. In miner economy: withdraws from containers/storage. |
| `defender`     | dynamic | `[ATTACK, MOVE]`      | Chases the highest-threat hostile. Marks idle and rallies near storage/spawn when no hostiles. Only produced during active threats. |
| `mineralMiner` | 0–1 (RCL 6+) | `[WORK×2, MOVE]` ×5 | Stands on mineral container and harvests when mineral is not depleted. Spawned only when extractor + container exist. |

Bodies are generated by `buildBody` (`src/utils/body.ts`), which repeats the pattern as many times as `energyCapacityAvailable` allows (default cap: 50 / pattern length). As the room's energy capacity grows, newly spawned creeps automatically get larger bodies.

### Spawn priority

The spawn queue in `src/managers/spawner.ts` is rebuilt each tick per room by `buildSpawnQueue(room)` and evaluated top-down; the first role below its `minCount` that a spawn can afford is produced, and only one creep is spawned per room per tick.

**Miner economy** (once source containers are built):

0. defender (dynamic — only when threats active)
1. miner (1 per source with a container)
2. hauler (2–3 per unlinked source, 1 total for linked sources)
3. harvester (1 — emergency bootstrap)
4. upgrader (1–6, scales with capacity + storage surplus: >50k/200k/500k = +1/+2/+3)
5. builder (1–3, scales with active construction sites: `ceil(sites / 3)`)
6. repairer (1–2, scales to 2 when >5 damaged structures)
7. mineralMiner (0–1, RCL 6+ when extractor + container + mineral available)

**Bootstrap economy** (before containers):

0. defender (dynamic)
1. harvester (2)
2. upgrader (2)
3. builder (1–3, scales with active construction sites)
4. repairer (1–2, scales with damage)

All counts are computed per-room per-tick. Idle builders and repairers fall back to upgrading the controller, so they're never wasted even when their primary work dries up.

The room transitions from bootstrap to miner economy automatically when `ensureRoomPlan()` detects the first source container is built (`RoomMemory.minerEconomy = true`).

## Gameplay Progression

Progression is driven by the controller level (RCL) of each owned room. The construction manager (`src/managers/construction.ts`) places sites near the first spawn as capacity unlocks, and the spawner scales creep bodies with `energyCapacityAvailable`.

### Structure caps per RCL

| RCL | Extensions | Towers | Links | Containers | Storage | Other |
|-----|------------|--------|-------|------------|---------|-------|
| 1   | 0          | 0      | 0     | —          | —       | —     |
| 2   | 5          | 0      | 0     | Source + controller | — | Roads |
| 3   | 10         | 1      | 0     | "          | —       | Roads, ramparts |
| 4   | 20         | 1      | 0     | "          | 1       | Roads, ramparts |
| 5   | 30         | 2      | 2     | "          | "       | Roads, ramparts |
| 6   | 40         | 2      | 3     | + mineral  | "       | Roads, ramparts, extractor, terminal |
| 7   | 50         | 3      | 4     | "          | "       | "    |
| 8   | 60         | 6      | 6     | "          | "       | "    |

- **Extensions** use a compact stamp pattern (`EXTENSION_STAMP`) around the spawn with road corridors on the cardinal axes. Falls back to ring scanning if stamp positions are terrain-blocked.
- **Towers** are placed on ring positions 3–6 tiles from the first spawn.
- **Source containers** are placed at RCL 2+ on the first path step from each source toward the spawn (so they sit on the road, adjacent to the source).
- **Controller container** is placed at RCL 2+ within range 2 of the controller (on the path toward spawn), so upgraders can stand on it and still be in upgradeController range (3).
- **Storage** is placed at RCL 4+ in an open position 2–4 tiles from the first spawn.
- **Links** are placed at RCL 5+. Priority: storage link (within 2 tiles of storage), then source link (within 2 tiles of most distant source), then controller link at RCL 6+ (within 3 tiles of controller).
- **Extractor** is placed on the room mineral at RCL 6+. A mineral container is placed adjacent.
- **Terminal** is placed at RCL 6+ within 1–3 tiles of storage.
- **Ramparts** are placed at RCL 3+ on spawns, towers, and storage.
- **Roads** start at RCL 2. The manager paths from the spawn to each source, the controller, and storage (when built), placing at most one road site per tick and capping open road sites at 3.

### Economy transition

The room starts in **bootstrap economy** (harvesters self-harvest and deliver) and transitions to **miner economy** when the room planner (`src/utils/roomPlanner.ts`) detects the first source container is built. The transition is automatic and tracked via `RoomMemory.minerEconomy`.

In miner economy:
- Static **miners** (WORK+CARRY+MOVE) sit on source containers and harvest continuously. With CARRY parts, they can transfer energy directly to adjacent links.
- **Haulers** (CARRY + MOVE) empty the storage link (priority), then source containers, delivering to spawn/extensions/towers/controller container/storage.
- **Upgraders** switch to heavy WORK bodies and withdraw from the controller container or storage instead of self-harvesting. They camp at the controller permanently. Count scales with storage surplus.
- **Builders** and **repairers** withdraw from the nearest source container or storage (via `withdrawFromLogistics()`) instead of self-harvesting.
- One **harvester** is kept as an emergency bootstrap in case all miners die simultaneously.

### Typical progression

1. **RCL 1 (bootstrap):** Two harvesters feed the spawn; two upgraders push the controller toward RCL 2. One builder and one repairer idle-upgrade until there is work.
2. **RCL 2 (transition):** Extensions, roads, source containers, and controller container construction sites appear. Once the first source container is built, the room switches to miner economy — miners, haulers, and heavy-WORK upgraders replace the harvester-based flow. Upgrade throughput jumps significantly.
3. **RCL 3:** The first tower goes up; ramparts are placed on critical structures. The tower manager starts defending, healing, and repairing (holding 50% of its energy in reserve for combat).
4. **RCL 4:** Storage is built; haulers stockpile surplus. Upgrader count scales with storage energy (>50k/200k/500k). Extension stamp fills out to 20.
5. **RCL 5:** Two links are built — storage link (receiver) and source link (sender). Miners transfer energy to the source link; it transfers instantly to the storage link; a hauler empties it. Hauler count drops for linked sources. Second tower comes online.
6. **RCL 6:** Third link (controller or second source). Extractor + mineral container placed on the room mineral; a mineralMiner spawns. Terminal placed near storage. Haulers carry minerals to storage.

### Tower behavior

For each room with towers, each tick (`src/managers/towers.ts`):

1. If any hostile is present, **every tower in the room focus-fires the highest-threat target** (see Defense below). Concentrating fire kills healers before they can negate the damage, which a closest-target approach can fail to do.
2. Otherwise, each tower heals the closest damaged friendly creep.
3. Otherwise, if the tower is at ≥50% energy, it repairs damaged structures (cached per room per tick). Walls and ramparts are repaired up to `wallRepairMax(room)`, which scales with storage energy (stored × 0.5) clamped to per-RCL caps (10k at RCL 3, up to 50M at RCL 8). Other structures are repaired below 75% of max HP. The 50%-energy reserve guarantees combat responsiveness when hostiles arrive.

## Defense

`src/managers/defense.ts` coordinates the whole defense stack; `src/utils/threat.ts` scores hostiles by body parts; `src/managers/towers.ts` uses that scoring to focus-fire; `src/roles/defender.ts` is the in-room melee unit.

### Threat scoring (`src/utils/threat.ts`)

Each hostile creep's `threatScore` is the sum of per-part values, ignoring dead parts (`hits === 0`):

| Part           | Score |
|----------------|-------|
| `HEAL`         | 250   |
| `CLAIM`        | 200   |
| `RANGED_ATTACK`| 150   |
| `ATTACK`       | 80    |
| `WORK`         | 30    |

`pickPriorityTarget(room)` returns the highest-scoring hostile in a room, breaking ties on current hits ascending (finish the weak ones first). Scouts score 0 but are still engaged to deny intel.

### Safe mode

`runDefense()` auto-activates safe mode on an owned controller when:

- The controller has `safeModeAvailable > 0` and no cooldown,
- Safe mode is not already active,
- A hostile with `threatScore > 0` is within range 5 of a spawn, the storage, or the controller.

This treats "breach of the base perimeter" as the trigger — scouts wandering the corner of the room don't burn a safe-mode charge.

### Defender spawning

Threat is tracked per room in `RoomMemory.threatLastSeen` / `lastThreatScore`. While the last sighting is within 50 ticks:

```
defendersNeeded(room) = min(ceil(threatScore / 200), 4)
```

The spawner prepends a `defender` request with that `minCount` to the head of the spawn queue. The 50-tick memory window prevents an attacker who briefly steps out of sight from cancelling a defender mid-spawn. When the room has been clear for longer than the window, defender production stops naturally — no standing army in peacetime.

## Memory

Screeps parses `Memory` from a JSON blob on first access each tick, so keeping it small and split-out matters as persistent data grows. The project uses three layers:

- **`Memory` (standard)** — hot, small data. Today: `Memory.creeps[name] = { role }` plus per-room slots in `Memory.rooms[name]` (empty by default; managers fill it as they need planned positions, cached ids, etc.). Dead-creep entries are purged each tick in `runRooms`.
- **`RawMemory.segments` via `src/utils/segments.ts`** — cold/large data (room plans, scout reports, stats archives). The wrapper parses lazily on first read, dirty-tracks writes so only mutated segments serialise, and lets managers queue segments for next-tick availability with `requestSegment(id)`. Call `flushSegments()` once per tick (already wired in `main.ts`). Screeps allows at most 10 active segments per tick out of 100 total; the wrapper caps requests accordingly.
- **`src/utils/tickCache.ts`** — transient per-tick memoisation cleared at `resetTickCache()`. Use `cached(key, () => expensive())` to share expensive calls between unrelated managers within a tick. The spawner uses it to tally creep counts by role once per tick instead of once per queue entry.

`src/utils/memoryInit.ts` guarantees the top-level shape (`Memory.creeps`, `Memory.rooms`) exists after a global reset, so hot-path code never has to guard with `??= {}`.

### Memory toggles

Two flags control opt-in behaviour; set them from the in-game console:

- `Memory.profiling = true` — enables CPU sampling.
- `Memory.visuals = true` — enables the per-room debug overlay.

Both default off.

## Profiling

`src/utils/profiler.ts` provides a minimal, bounded CPU profiler. `profile(name, fn)` records the `Game.cpu.getUsed()` delta of `fn()` into `Memory.stats[name]` as an exponential moving average (one slot per label, no unbounded history).

Instrumentation points (all gated by `Memory.profiling`, so production ticks pay ~nothing when it's off):

- `main.loop` — the whole tick.
- `defense`, `spawner`, `links`, `rooms`, `towers`, `construction`, `visuals` — each manager.
- `role.<roleName>` — per-creep dispatch, labelled with the role so hot roles surface separately.

`installProfilerGlobals()` is called once per global reset from `main.ts`, registering two console-callable functions:

```text
stats()         // print a sorted table: name / avg / last / max / n
resetStats()    // clear Memory.stats
```

Each `ProfilerSample` (`src/types.d.ts`) tracks `{ avg, last, max, samples }`.

## Visual Debugging

`src/managers/visuals.ts` renders per-room `RoomVisual` overlays for owned rooms. It runs under `profile('visuals', …)` and is gated by `Memory.visuals`, so when disabled it's a single boolean check per tick.

When enabled, for each owned room it draws:

- A header with current RCL and `energyAvailable / energyCapacityAvailable`.
- A summary of creep counts by role (e.g. `builder:1 harvester:2 repairer:1 upgrader:2`).
- Last-tick CPU (`cpu used / limit`) — matches the `main.loop` entry in `stats()` when profiling is on.
- A `⛏ N` marker above each source showing how many creeps are within range 2 (red when zero — likely an under-served source).
- **Idle creep indicators** — grey circle overlay on creeps with no current task (auto-clears when they get work).
- **Path visualizations** — dashed lines showing each creep's intended path, color-coded by activity.

### Path colors

| Color | Hex | Activity |
|-------|-----|----------|
| Orange | `#ffaa00` | Gathering energy — miners positioning, haulers picking up, upgraders/builders/repairers withdrawing |
| Green | `#33ff33` | Builders moving to construction sites |
| White | `#ffffff` | Haulers delivering to spawns/extensions/towers/controller container/storage |
| Blue | `#3333ff` | Upgrading controller (upgraders, and builders/repairers falling back to upgrade) |
| Red | `#ff0000` | Defenders attacking hostiles |
| Purple | `#cc66ff` | Mineral operations — mineral miner positioning, haulers carrying minerals |
| Grey | `#888888` | Idle creeps rallying toward storage/spawn |

Extend `runVisuals()` with more overlays (construction plans, tower ranges, etc.) as the AI grows.

## Extending

- **New role:** Add `src/roles/<name>.ts` exporting a `Role`, define states as a `StateMachineDefinition`, register it in `src/roles/index.ts`, extend `CreepRoleName` in `src/types.d.ts`, and add an entry to the spawn queue in `src/managers/spawner.ts`. Use `moveTo()` with appropriate `PRIORITY_*` for movement. If the role can go idle (no work to do), call `markIdle(creep)` from `src/utils/idle.ts`. Add tests in `test/roles/`.
- **New structure placement:** Extend `src/managers/construction.ts` with another `place*` function and an RCL cap map.
- **Smarter pathing / memory:** `CreepMemory` is intentionally minimal — add fields (e.g. `targetId`, assigned source) as roles grow. Put cold per-room planning data on `Memory.rooms[name]` (extend `RoomMemory` in `types.d.ts`) or in a `RawMemory` segment via `src/utils/segments.ts`.
- **New manager or hot path:** Wrap it in `profile('yourLabel', fn)` so CPU cost shows up in `stats()`, and consider memoising expensive finds via `cached(key, () => …)` from `src/utils/tickCache.ts`.
- **New overlay:** Add a draw function to `src/managers/visuals.ts` using `room.visual`; the manager is already gated by `Memory.visuals` and profiled.
- **Tests:** Add or update tests in `test/` when modifying utility functions, manager logic, or role state machines. Run `npm test` before committing.
