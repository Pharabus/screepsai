# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — Rollup bundles `src/main.ts` into `dist/main.js` + source map. The Screeps runtime loads `dist/main.js` as the AI entry point.
- `npm run watch` — Rollup in watch mode.
- `npm run deploy` — Bumps patch version, builds, then uploads `dist/main.js` to Screeps world servers via `scripts/deploy.mjs` (reads `SCREEPS_TOKEN` and `SCREEPS_BRANCH` from `.env`).
- `npm run localdeploy` — Bumps patch version and builds only (no upload). Use when copying `dist/main.js` to a local Screeps server manually.
- `npm run lint` — ESLint over `src/`.
- `npm run format` / `npm run format:check` — Prettier.
- `npx tsc --noEmit` — Type-check only.
- `npm test` — Run all Vitest tests (`test/**/*.test.ts`).
- `npm run test:watch` — Vitest in watch mode.
- `npm run test:coverage` — Run tests with V8 coverage report.

Pre-commit hooks (husky + lint-staged) run `prettier --check` and `eslint` on staged `.ts` files automatically.

## Architecture

The AI is a single `loop` function exported from `src/main.ts`, called once per tick by the Screeps runtime. The loop is structured as a linear pipeline of managers, each wrapped in `profile(name, fn)` for per-manager CPU accounting.

### Tick pipeline (order matters)

1. `initMemory()` — one-shot Memory shape init (per global reset).
2. `resetTickCache()` — clears the transient per-tick memoisation map.
2b. `resetTraffic()` — clears intent-based traffic manager state.
2c. `resetIdle()` — clears the idle creep set for fresh per-tick tracking.
3. `runDefense` — scans hostiles, updates `RoomMemory.threatLastSeen` / `lastThreatScore`, activates safe mode on perimeter breach. Runs first so the spawner and towers see the same threat view.
4. `runSpawner` — calls `ensureRoomPlan(room)` to refresh source/container/miner cache, runs `selectRemoteRooms` every 100 ticks, scans remote rooms via `ensureRemoteRoomPlan`, then **rebuilds the spawn queue per room** via `buildSpawnQueue(room)`. Uses bootstrap economy (harvester-based) until the first source container is detected, then switches to miner economy (miner + hauler + heavy-WORK upgrader). Hauler count: base 2 (linked sources add `min(linked,1)`, unlinked add 2–3 per source depending on capacity), +1 when mineral mining is active (`mineralContainerId` set and mineral not depleted — drops to 0 during regeneration). Upgrader count scales with storage reserves: 1 when storage < 50k, 2 when < 100k, then 3 at 100k–200k, 4 at 200k–500k, 5 above 500k. The 50k threshold lets storage accumulate a meaningful buffer before adding a second upgrader competing for energy. Builder spawning is paused (0 requested) when all sources are linked and storage energy is below `STORAGE_ENERGY_FLOOR` (10k) — in a fully-linked room, builders have no efficient logistics source below this threshold and would fall back to competing with miners at sources. Remote mining roles (scout, remote miners, remote haulers) are appended at lowest priority in miner economy. Defenders are prepended dynamically when threats are active.
5. `runLinks` — transfers energy from source links to storage link (primary) or controller link (secondary). Runs before rooms so creeps see fresh link state.
6. `runRooms` — purges dead-creep memory, then dispatches each creep to its role via the `roles` registry (`src/roles/index.ts`). Roles register movement intents via `moveTo()` during this phase. Per-creep calls are profiled as `role.<roleName>`.
6b. `resolveTraffic` — processes all movement intents registered during `runRooms`, resolves tile conflicts by priority, and issues `creep.move()` calls.
7. `runTowers` — every tower in a room focus-fires `pickPriorityTarget(room)` (threat-scored, not closest). Falls back to heal → repair with a 50% combat energy reserve. Wall/rampart repair target scales with storage energy via `wallRepairMax(room)`.
7b. `runLabs` — selects a reaction from available minerals (re-evaluated every 500 ticks), runs `outputLab.runReaction(inputLab1, inputLab2)` on all output labs each tick when input labs are loaded. Stores the active reaction in `RoomMemory.activeReaction`. When a reaction change leaves stale minerals in input labs, sets `RoomMemory.labFlushing` — hauler withdraws wrong minerals before loading new inputs, flag auto-clears when labs are clean.
7c. `runTerminal` — runs every 100 ticks. Sells surplus minerals (above `MINERAL_TERMINAL_CEILING` = 50k) to the best buy order via `Game.market.deal()`. One sale per terminal per interval. Gated by minimum price (0.01) and energy cost check (`ENERGY_TERMINAL_BUFFER` = 50k reserved). Shared thresholds live in `src/utils/thresholds.ts`.
8. `runConstruction` — runs every 5 ticks. Places structures in priority order: source containers → controller container → storage → links → extensions → towers → roads → corridor roads → remote roads → terminal → extractor → mineral container → labs → ramparts. Each `place*` function is RCL-gated. Terminal, extractor, mineral container, and labs are also gated behind link completion — they won't place construction sites while any link site is under construction, ensuring builders prioritize energy infrastructure. `placeCorridorRoads()` builds roads along the dx=0 and dy=0 corridors through the extension diamond for creep accessibility. `placeRemoteRoads()` uses cross-room `PathFinder.search` from the home spawn to each remote source, placing road sites incrementally (one per tick). Only targets reserved rooms with an active reserver.
9. `runVisuals` — opt-in `RoomVisual` overlay, gated by `Memory.visuals`.
10. `flushSegments` — writes dirty `RawMemory.segments` entries and registers requested segments for next tick.

Reordering these has subtle effects: e.g. moving `runSpawner` ahead of `runDefense` would make defender production lag a tick behind sightings.

### Memory model (three layers, pick the right one)

- **`Memory`** — hot, small. Today: `Memory.creeps[name].role`, `Memory.rooms[name]` (threat fields), `Memory.stats` (profiler), and two toggles (`profiling`, `visuals`). Screeps JSON-parses this blob on first access each tick, so keep it small.
- **`RawMemory.segments` via `src/utils/segments.ts`** — cold/large data (room plans, scout reports, historical stats). Lazy parse on read, dirty-flag writes (only mutated segments serialise at `flushSegments()`). At most 10 segments may be active per tick; use `requestSegment(id)` to queue for next tick.
- **`src/utils/tickCache.ts`** — within-tick memoisation, cleared by `resetTickCache()`. Use `cached(key, () => expensive())` when multiple managers need the same `room.find` / aggregate.

`src/utils/memoryInit.ts` guarantees `Memory.creeps` and `Memory.rooms` exist after a global reset so hot-path code doesn't need `??= {}` guards.

### Adding a role

1. Create `src/roles/<name>.ts` exporting a `Role` (`run(creep): void`).
2. Define states as a `StateMachineDefinition` (see `src/utils/stateMachine.ts`) and call `runStateMachine(creep, states, defaultState)` from `run()`.
3. Register it in `src/roles/index.ts`.
4. Extend the `CreepRoleName` union in `src/types.d.ts`.
5. Add a `SpawnRequest` entry in `buildSpawnQueue()`. Prefer a dynamic `*Needed(room)` function (see `buildersNeeded`, `repairersNeeded`, `upgradersNeeded` as examples) over a hardcoded `minCount`. Every role's count should reflect current room state so the economy self-balances.
6. Set appropriate movement priority via `moveTo(creep, target, { priority: PRIORITY_* })`. Stationary roles (miners) should call `registerStationary(creep, PRIORITY_STATIC)` in their harvest state.

The TypeScript union + `Record<CreepRoleName, Role>` in the registry means forgetting any of these steps is a compile error.

### Shared utilities for roles

- **`gatherEnergy(creep)`** (`src/utils/sources.ts`) — shared GATHER state logic used by builder and repairer. Withdraws from logistics in miner economy, self-harvests in bootstrap. Returns `true` when store is full. `withdrawFromLogistics` priority: storage (above `STORAGE_ENERGY_FLOOR` 10k) → storage link → dropped energy → any source container (>100 energy, including linked) → gives up (caller falls back to self-harvest).
- **`deliverToSpawnOrExtension(creep)`** / **`deliverToControllerContainer(creep)`** (`src/utils/delivery.ts`) — shared delivery helpers used by hauler and remoteHauler. Return `true` if a target was found. `deliverToSpawnOrExtension` opportunistically fills any adjacent (range 1) spawn/extension before pathing, then caches a movement target across ticks. Multiple haulers spread across unclaimed targets to avoid convergence oscillation.
- **Hauler pickup priority** (`src/roles/hauler.ts`): committed target (continue previous task if still valid) → urgent responder (storage → spawn/ext when structures need energy, nearest hauler only; won't preempt a committed target within range 3) → storage link (≥200 energy threshold — catches real link transfers, ignores scraps) → dropped energy (≥50) → dropped minerals (≥50, non-energy) → full source containers (≥1000) → mineral container (non-energy) → any source container (>0) → lab flush/input/output → terminal minerals. Task commitment prevents flip-flopping: once a hauler picks a target, it finishes the trip before re-evaluating priorities. Controller container delivery requires ≥200 free capacity to prevent trivial top-off diversions.

### Body scaling

`src/utils/body.ts` `buildBody(pattern, energy, maxRepeats?)` repeats a body pattern as many times as the room's `energyCapacityAvailable` allows. Spawner always passes `spawn.room.energyCapacityAvailable`, so creeps automatically grow as extensions get built — do not hardcode bodies. Specialized builders exist for miners (`buildMinerBody` — maximizes WORK, cap 6), upgraders (`buildUpgraderBody` — maximizes WORK, cap 15), and remote miners (`buildRemoteMinerBody` — WORK+MOVE pairs at 1:1 ratio for off-road travel, plus 1 CARRY for building containers, cap 5 WORK). Non-production roles are capped via `maxRepeats` to control spawning cost: haulers ×8 (1600 energy), remote haulers ×8 (1600 energy), harvesters ×4 (800), builders ×4 (1000), repairers ×4 (800).

### Defense

- `src/utils/threat.ts` scores hostile creeps by body parts (HEAL 250 > CLAIM 200 > RANGED_ATTACK 150 > ATTACK 80 > WORK 30; dead parts ignored). `pickPriorityTarget(room)` returns the top-scoring hostile using a composite score: `threatScore * 10,000 + towerEffectiveness * 1,000 - hits`. Tower effectiveness is range-weighted (1.0 at range ≤5, 0.25 at range ≥20, linear between) using average distance from all towers — this prevents wasting tower ammo on border creeps while closer hostiles roam free. Zero-threat hostiles are still targeted; closer ones are preferred.
- Focus-fire (`managers/towers.ts`) is the deliberate policy — closest-target fire lets healers keep attackers alive indefinitely.
- Safe mode activates only when a hostile with `threatScore > 0` is within range 5 of a spawn / storage / controller, so scouts don't burn a charge.
- `defendersNeeded(room)` = `min(ceil(threatScore / 200), 4)` while `threatLastSeen` is within 50 ticks. The memory window prevents an attacker stepping briefly out of view from cancelling an in-progress defender spawn.

### Profiling & visuals (opt-in)

Both gated by Memory flags so production ticks pay ~nothing when off:

- `Memory.profiling = true` → `profile(name, fn)` records CPU deltas as exponential moving averages in `Memory.stats`.
- `Memory.visuals = true` → `runVisuals()` draws per-room RCL/energy/creep-count/CPU headers, source-load markers, and idle creep indicators (grey circles).

When adding a new manager or hot path, wrap it in `profile('label', fn)` so it surfaces in `stats()`.

Console-callable exports from `main.ts`: `stats()`, `resetStats()`, `status()`. The Screeps console evaluates against `global` in IVM — to expose a new console command, add an `export const` in `main.ts` and register it on `global`.

### Creep state machine

All roles use `src/utils/stateMachine.ts`. Each role defines a `StateMachineDefinition` — a `Record<string, StateHandler>` where each handler's `run(creep)` returns a state name to transition or `undefined` to stay. State is persisted in `creep.memory.state`. The engine validates the state exists (falls back to default on code deploy with renamed states) and calls optional `onEnter()` on transitions. Inspect `creep.memory.state` in-game to see what any creep is doing.

### Movement & traffic

`src/utils/movement.ts` provides a `moveTo` wrapper used by all roles. Each creep computes its own path via `PathFinder.search` and issues `creep.move(direction)` directly — there is no centralised intent queue. Traffic avoidance is handled entirely through the CostMatrix (`src/utils/trafficManager.ts`, cached per room per tick): roads cost 1, other creeps cost 15 (soft avoid — paths route around clusters but can go through), stationary creeps (miners) cost 255 (hard block — paths must go around), impassable structures cost 255, hostile creeps cost 255. Stationary roles call `registerStationary(creep, PRIORITY_STATIC)` to mark their tile as impassable in the CostMatrix. The Screeps engine handles 2-way swaps natively when both creeps move into each other's tile. A stuck detection fallback in `movement.ts` bypasses to native `creep.moveTo(reusePath: 0)` after 3 ticks at the same position. Always use `moveTo()` instead of direct `creep.moveTo()` or `creep.move()`.

For cross-room movement, `getPath` uses `maxRooms: 2` when the target is in a different room than the creep. The `roomCallback` returns per-room CostMatrix when visibility exists, or `false` for unseen rooms (PathFinder uses default terrain costs). Remote roles path directly to stored source positions via `RoomPosition` constructed from Memory coordinates — no `Game.map.findExit` needed.

When a role's `moveTo` target requires standing on a specific tile (e.g. miner on container), pass `range: 0` — the default range is 1, and the traffic manager skips movement when already in range.

### Remote mining

Remote mining sends creeps to harvest sources in adjacent unowned rooms. Gated by miner economy (containers must be built first). The flow:

1. A `scout` (1 MOVE) explores adjacent rooms and records source count, ownership, hostile presence, and source positions (`scoutedSourceData`) in `RoomMemory`. Re-scouts rooms every 5000 ticks. Only spawned when `findScoutTarget()` finds an unscouted or stale room — no permanent scout is kept alive.
2. `selectRemoteRooms()` (`src/utils/remotePlanner.ts`) evaluates scouted rooms every 100 ticks — rejects owned rooms, rooms reserved by other players (own reservations are accepted), sourceless rooms, and rooms with recent hostile sightings (< 1500 ticks old). Picks up to 2 best by source count, stores in `RoomMemory.remoteRooms`.
3. `ensureRemoteRoomPlan()` scans sources in remote rooms we have visibility into; bootstraps source data from `scoutedSourceData` when no visibility.
4. Remote miners (reusing `miner` role with `targetRoom` set) path directly to stored source positions via cross-room PathFinder. They harvest at the source and build their own container (they have 1 CARRY part for this). Once the container is built, the miner also repairs it when damaged (using the same CARRY buffer — home miners use theirs for link transfers instead). Before the container is built, energy drops on the ground for haulers.
5. `remoteHauler` creeps pick up dropped energy or withdraw from containers in the remote room, then deliver to storage/spawns/towers/controller container in the home room. When idle in the remote room, they wait near the source to avoid border-tile bouncing.

`CreepMemory.homeRoom` identifies which room a remote creep belongs to. `CreepMemory.targetRoom` tells it which room to operate in. Local miners have neither field set.

6. A `reserver` (`[CLAIM×2, MOVE×2]`, 1300 energy) continuously calls `reserveController()` on a remote room's controller. 2 CLAIM parts add +2 reservation ticks per call (net +1/tick after decay), doubling source capacity (1500 → 3000 energy/regen) and halving container decay. Spawned 1 per remote room that has a controller (gated by `scoutedHasController`). Scout records controller presence during room scanning.
7. `remoteBuilder` (`[WORK, CARRY, MOVE, MOVE] × 4`, 1000 energy) travels to the remote room, gathers energy from containers/drops, and builds road construction sites placed by `placeRemoteRoads`. Falls back to repairing damaged roads (< 75% HP). Spawned 1 per remote room when construction sites exist OR roads are below 50% HP. Temporary role — stops spawning once roads are built and healthy.

Future concerns for claiming are tracked in `todo.md`.

### Idle creep management

`src/utils/idle.ts` provides `markIdle(creep)` for roles that have no work to do. It registers the creep as idle (for visual indicators), and rallies the creep toward storage or spawn (range 3) so it doesn't block traffic near busy areas. Roles that can go idle: hauler (nothing to pick up or deliver), harvester (all delivery targets full), defender (no hostiles). Builders, repairers, and upgraders always fall back to upgrading the controller so they never idle. When `Memory.visuals` is enabled, idle creeps are marked with a grey circle overlay. The indicator auto-clears when the creep gets work (since `markIdle` is only called on idle ticks).

### Deployment

`scripts/deploy.mjs` POSTs `dist/main.js` to `https://screeps.com/api/user/code` using `X-Token` auth. Config lives in `.env` (gitignored); copy `.env.example` to get started. After a successful deploy, the script lists all branches and warns if the target branch isn't the active world branch.

The rollup build stamps a version banner (`// screepsAI v{version} - built {timestamp}`) on line 1 of `dist/main.js`, read from `package.json`. `npm run deploy` auto-bumps the patch version before building.

### Error mapping

`src/utils/ErrorMapper.ts` wraps the main loop with `wrapLoop`. It uses a custom synchronous VLQ decoder (not the `source-map` package, which is async and too slow for Screeps) to map runtime errors back to TypeScript source lines. The bundled `main.js.map` is loaded via Screeps' `require('main.js.map')`; the parsed map is cached across ticks and rebuilt on global reset.

## Testing

Tests live in `test/` mirroring the `src/` structure. Vitest is the runner, configured in `vitest.config.ts` with `globals: true` (no imports needed for `describe`/`it`/`expect`).

`test/mocks/screeps.ts` is a setup file that injects Screeps constants (`WORK`, `FIND_STRUCTURES`, etc.) and provides `mockCreep()`, `mockRoom()`, and `resetGameGlobals()` factory helpers. Call `resetGameGlobals()` in `beforeEach` when tests mutate `Game` or `Memory`.

**When to write tests:** When adding or modifying utility functions, manager logic, or role state machines, add or update corresponding tests. Pure logic (no Screeps runtime dependency) is highest priority. Functions that need only light mocking (mock creep/room) are also good candidates. Skip tests for code tightly coupled to the Screeps runtime (construction placement, error mapping, the main loop). Well-tested modules: `sources.ts`, `remotePlanner.ts`, `roomPlanner.ts`, `scout.ts`, `miner.ts`, `threat.ts`, `body.ts`, `stateMachine.ts`, `spawner.ts`, `labs.ts`, `hauler.ts`, `remoteHauler.ts`, `construction.ts`, `terminal.ts`, `reserver.ts`.

**To make internal functions testable:** Export them. The spawner's `*Needed()` functions and `buildSpawnQueue()` are exported specifically for testing.

## TypeScript / Screeps specifics

- `tsconfig.json` uses `strict` + `noUncheckedIndexedAccess`. `Game.creeps[name]` and similar index accesses return `T | undefined` — always null-check.
- `lib` is `ES2021` (no DOM). A minimal `console` and `require` are declared in `src/types.d.ts` for the Screeps sandbox globals. Do not add `@types/node`.
- The rollup bundle marks `lodash` as external because Screeps provides it globally. Do not import lodash in new code — use native `Object.values` / array methods (this was a deliberate cleanup).
- `"type": "commonjs"` in `package.json`; rollup outputs CJS because the Screeps VM is CJS.
- Screeps IVM uses `global` (not `globalThis`). `global` is declared in `src/types.d.ts`. `module` is also declared there for the console export pattern.
- Do not add `@types/node` — the Screeps VM is not Node. Minimal globals (`console`, `require`, `global`, `module`) are declared in `src/types.d.ts`.

## Source of truth

README.md is kept factual against the current source and covers the same material at more length. todo.md tracks outstanding work in priority order; check it before starting anything ambitious so you don't duplicate a staged plan (e.g. non-energy resource harvesting already has a detailed RCL-gated plan laid out).
