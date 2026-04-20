# Screeps AI

A TypeScript Screeps AI focused on automated room bootstrapping: spawning a balanced creep workforce, expanding the base (extensions, towers, roads) as the controller levels up, and defending with towers.

## Features

- **TypeScript** with strict mode, bundled by Rollup into a single `dist/main.js`.
- **ErrorMapper** to translate runtime errors back to TypeScript source lines.
- **Priority-based spawner** that maintains minimum creep counts per role and scales bodies to the room's `energyCapacityAvailable`.
- **Automated construction manager** that places extensions, towers, and roads based on RCL.
- **Defense stack** — threat-scored focus-fire for towers, automatic safe-mode activation on base-perimeter breach, and reactive `defender` creeps spawned by a dynamic spawn queue.
- **Load-balanced harvesting** that spreads creeps across available sources.
- **Memory optimisations** — lazy `RawMemory` segment wrapper, per-tick cache, and one-shot Memory shape init to keep the per-tick JSON parse cheap as persistent data grows.
- **CPU profiler** with exponential-moving-average samples per manager and per role, exposed via console globals `stats()` / `resetStats()`.
- **Visual debugging overlay** (opt-in) drawing per-room RCL / energy / creep counts / source load via `RoomVisual`.

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
- `npm run deploy` — Builds and uploads to Screeps via `screeps-api` (`--branch default`).
- `npm run lint` — Runs ESLint over `src/`.
- `npm run format` / `npm run format:check` — Prettier.

### Deploying

`npm run deploy` wraps `screeps-api upload --branch default dist/main.js`. Configure credentials per the `screeps-api` docs, or manually paste `dist/main.js` into the in-game editor.

## Project Structure

```
src/
  main.ts                 # Game loop entry; per-tick init, manager dispatch, segment flush
  managers/
    spawner.ts            # Priority queue of creep roles, scales bodies to energy
    room.ts               # Per-tick creep dispatch + dead-creep memory cleanup
    towers.ts             # Focus-fire attack / heal / repair logic for towers
    construction.ts       # Places extensions, towers, and roads based on RCL
    defense.ts            # Threat tracking, safe-mode activation, defender demand
    visuals.ts            # Opt-in RoomVisual overlays (gated by Memory.visuals)
  roles/
    Role.ts               # Role interface (run(creep))
    index.ts              # Role registry keyed by CreepRoleName
    harvester.ts
    upgrader.ts
    builder.ts
    repairer.ts
    defender.ts
  utils/
    body.ts               # buildBody(pattern, energy, maxRepeats)
    sources.ts            # findBestSource / harvestFromBestSource (load-balanced)
    threat.ts             # threatScore / pickPriorityTarget for hostile creeps
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
3. `runDefense()` — Refreshes per-room threat state and activates safe mode if a hostile has breached the base perimeter. Runs first so the spawner and towers both see the same threat view.
4. `runSpawner()` — Walks the (dynamically built) spawn queue and issues one spawn per tick if a role is under its minimum.
5. `runRooms()` — Cleans `Memory.creeps` entries for dead creeps, then dispatches each living creep to its role handler.
6. `runTowers()` — All towers focus-fire the highest-threat hostile; otherwise heal wounded allies, then repair.
7. `runConstruction()` — Places one new extension/tower/road site per tick as RCL allows.
8. `runVisuals()` — Opt-in `RoomVisual` overlay (no-op unless `Memory.visuals` is true).
9. `flushSegments()` — Serialises any mutated `RawMemory.segments` entries and registers requested segments for the next tick.

Each of steps 3–8 is wrapped in `profile(...)` so per-manager CPU cost surfaces in `stats()`. Per-creep dispatch in step 5 is labelled `role.<roleName>` for per-role CPU tracking.

## Roles

All roles implement the `Role` interface (`run(creep: Creep): void`) in `src/roles/Role.ts`. Each non-harvester role refills by calling `harvestFromBestSource` when empty, which picks the active source with the fewest nearby harvesters and breaks ties by distance (`src/utils/sources.ts`).

| Role        | Minimum | Body pattern        | Behavior |
|-------------|---------|---------------------|----------|
| `harvester` | 2       | `[WORK, CARRY, MOVE]` | Harvests until full, then delivers energy to the nearest spawn / extension / tower with free capacity. |
| `upgrader`  | 2       | `[WORK, CARRY, MOVE]` | Harvests until full, then upgrades the room controller. |
| `builder`   | 1       | `[WORK, CARRY, MOVE]` | Harvests until full, builds the first available construction site, and falls back to upgrading the controller when nothing is under construction. |
| `repairer`  | 1       | `[WORK, CARRY, MOVE]` | Harvests until full, then repairs any non-wall structure below 75% HP. Falls back to upgrading the controller if nothing needs repair. |
| `defender`  | dynamic | `[ATTACK, MOVE]`      | Chases the highest-threat hostile in its room. When the room is clear, rallies within range 3 of the first spawn. Only produced while the defense manager reports an active threat. |

Bodies are generated by `buildBody` (`src/utils/body.ts`), which repeats the pattern as many times as `energyCapacityAvailable` allows (default cap: 50 / pattern length). As the room's energy capacity grows, newly spawned creeps automatically get larger bodies.

### Spawn priority

The spawn queue in `src/managers/spawner.ts` is rebuilt each tick by `buildSpawnQueue()` and evaluated top-down; the first role below its `minCount` that a spawn can afford is produced, and only one creep is spawned per tick:

0. defender (dynamic — only present when `defendersNeeded(room) > 0`; prepended ahead of everything else)
1. harvester (2)
2. upgrader (2)
3. builder (1)
4. repairer (1)

## Gameplay Progression

Progression is driven by the controller level (RCL) of each owned room. The construction manager (`src/managers/construction.ts`) places sites near the first spawn as capacity unlocks, and the spawner scales creep bodies with `energyCapacityAvailable`.

### Structure caps per RCL

| RCL | Extensions | Towers | Roads |
|-----|------------|--------|-------|
| 1   | 0          | 0      | —     |
| 2   | 5          | 0      | Enabled: spawn → sources, spawn → controller |
| 3   | 10         | 1      | "    |
| 4   | 20         | 1      | "    |
| 5   | 30         | 2      | "    |
| 6   | 40         | 2      | "    |
| 7   | 50         | 3      | "    |
| 8   | 60         | 6      | "    |

- **Extensions** are placed on ring positions 2–5 tiles from the first spawn, skipping walls and occupied tiles.
- **Towers** are placed on ring positions 3–6 tiles from the first spawn.
- **Roads** start at RCL 2. The manager paths from the spawn to each source and to the controller, placing at most one road site per tick and capping open road sites at 3 to control CPU and construction-energy load.

### Typical early-game flow

1. **RCL 1 (bootstrap):** Two harvesters feed the spawn; two upgraders push the controller toward RCL 2. One builder and one repairer idle-upgrade until there is work.
2. **RCL 2:** Extension construction sites start appearing around the spawn; the builder now has work, and roads to sources/controller begin getting paved. Larger bodies become possible as extensions fill.
3. **RCL 3:** The first tower goes up; the tower manager starts defending, healing, and repairing (holding 50% of its energy in reserve for combat). The repairer picks up the slack on non-wall structures below 75% HP.
4. **RCL 4+:** The extension count keeps scaling, which in turn scales body sizes via `buildBody`. Additional towers come online at RCL 5, 7, and 8.

### Tower behavior

For each room with towers, each tick (`src/managers/towers.ts`):

1. If any hostile is present, **every tower in the room focus-fires the highest-threat target** (see Defense below). Concentrating fire kills healers before they can negate the damage, which a closest-target approach can fail to do.
2. Otherwise, each tower heals the closest damaged friendly creep.
3. Otherwise, if the tower is at ≥50% energy, it repairs the closest damaged structure — walls and ramparts only if below 10,000 HP, other structures if below 75% of their max HP. The 50%-energy reserve guarantees combat responsiveness when hostiles arrive.

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
- `spawner`, `rooms`, `towers`, `construction`, `visuals` — each manager.
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

Extend `runVisuals()` with more overlays (construction plans, tower ranges, haul paths, etc.) as the AI grows.

## Extending

- **New role:** Add `src/roles/<name>.ts` exporting a `Role`, register it in `src/roles/index.ts`, extend `CreepRoleName` in `src/types.d.ts`, and add an entry to the spawn queue in `src/managers/spawner.ts`.
- **New structure placement:** Extend `src/managers/construction.ts` with another `place*` function and an RCL cap map.
- **Smarter pathing / memory:** `CreepMemory` is intentionally minimal — add fields (e.g. `working`, `targetId`, assigned source) as roles grow. Put cold per-room planning data on `Memory.rooms[name]` (extend `RoomMemory` in `types.d.ts`) or in a `RawMemory` segment via `src/utils/segments.ts`.
- **New manager or hot path:** Wrap it in `profile('yourLabel', fn)` so CPU cost shows up in `stats()`, and consider memoising expensive finds via `cached(key, () => …)` from `src/utils/tickCache.ts`.
- **New overlay:** Add a draw function to `src/managers/visuals.ts` using `room.visual`; the manager is already gated by `Memory.visuals` and profiled.
