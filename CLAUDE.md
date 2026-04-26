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
4. `runSpawner` — calls `ensureRoomPlan(room)` to refresh source/container/miner cache, runs `selectRemoteRooms` every 100 ticks, scans remote rooms via `ensureRemoteRoomPlan`, then **rebuilds the spawn queue per room** via `buildSpawnQueue(room)`. Uses bootstrap economy (harvester-based) until the first source container is detected, then switches to miner economy (miner + hauler + heavy-WORK upgrader). Remote mining roles (scout, remote miners, remote haulers) are appended at lowest priority in miner economy. Defenders are prepended dynamically when threats are active.
5. `runLinks` — transfers energy from source links to storage link (primary) or controller link (secondary). Runs before rooms so creeps see fresh link state.
6. `runRooms` — purges dead-creep memory, then dispatches each creep to its role via the `roles` registry (`src/roles/index.ts`). Roles register movement intents via `moveTo()` during this phase. Per-creep calls are profiled as `role.<roleName>`.
6b. `resolveTraffic` — processes all movement intents registered during `runRooms`, resolves tile conflicts by priority, and issues `creep.move()` calls.
7. `runTowers` — every tower in a room focus-fires `pickPriorityTarget(room)` (threat-scored, not closest). Falls back to heal → repair with a 50% combat energy reserve. Wall/rampart repair target scales with storage energy via `wallRepairMax(room)`.
7b. `runLabs` — selects a reaction from available minerals (re-evaluated every 500 ticks), runs `outputLab.runReaction(inputLab1, inputLab2)` on all output labs each tick when input labs are loaded. Stores the active reaction in `RoomMemory.activeReaction`.
7c. `runTerminal` — runs every 10 ticks. Stub for future market sell orders; hauler handles the actual storage→terminal mineral transfers.
8. `runConstruction` — runs every 5 ticks. Places extensions, towers, containers, storage, terminal, extractor, links, labs, roads, ramparts — gated by RCL checks in each `place*` function.
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

- **`gatherEnergy(creep)`** (`src/utils/sources.ts`) — shared GATHER state logic used by builder and repairer. Withdraws from logistics in miner economy, self-harvests in bootstrap. Returns `true` when store is full. Storage withdrawals are guarded by `STORAGE_ENERGY_FLOOR` (10k) to preserve reserves for spawning.
- **`deliverToSpawnOrExtension(creep)`** / **`deliverToControllerContainer(creep)`** (`src/utils/delivery.ts`) — shared delivery helpers used by hauler and remoteHauler. Return `true` if a target was found.

### Body scaling

`src/utils/body.ts` `buildBody(pattern, energy, maxRepeats?)` repeats a body pattern as many times as the room's `energyCapacityAvailable` allows. Spawner always passes `spawn.room.energyCapacityAvailable`, so creeps automatically grow as extensions get built — do not hardcode bodies. Specialized builders exist for miners (`buildMinerBody` — maximizes WORK, cap 6), upgraders (`buildUpgraderBody` — maximizes WORK, cap 15), and remote miners (`buildRemoteMinerBody` — WORK+MOVE pairs at 1:1 ratio for off-road travel, plus 1 CARRY for building containers, cap 5 WORK).

### Defense

- `src/utils/threat.ts` scores hostile creeps by body parts (HEAL 250 > CLAIM 200 > RANGED_ATTACK 150 > ATTACK 80 > WORK 30; dead parts ignored). `pickPriorityTarget(room)` returns the top-scoring hostile with a hits-ascending tiebreak. Zero-threat hostiles (scouts, stripped invaders) are still targeted — towers will finish off any hostile in the room.
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

1. A `scout` (1 MOVE) explores adjacent rooms and records source count, ownership, hostile presence, and source positions (`scoutedSourceData`) in `RoomMemory`. Re-scouts rooms every 5000 ticks. Idles near storage/spawn when all rooms are scouted.
2. `selectRemoteRooms()` (`src/utils/remotePlanner.ts`) evaluates scouted rooms every 100 ticks — rejects owned/reserved/sourceless rooms and rooms with recent hostile sightings (< 1500 ticks old). Picks up to 2 best by source count, stores in `RoomMemory.remoteRooms`.
3. `ensureRemoteRoomPlan()` scans sources in remote rooms we have visibility into; bootstraps source data from `scoutedSourceData` when no visibility.
4. Remote miners (reusing `miner` role with `targetRoom` set) path directly to stored source positions via cross-room PathFinder. They harvest at the source and build their own container (they have 1 CARRY part for this). Once the container is built, the miner also repairs it when damaged (using the same CARRY buffer — home miners use theirs for link transfers instead). Before the container is built, energy drops on the ground for haulers.
5. `remoteHauler` creeps pick up dropped energy or withdraw from containers in the remote room, then deliver to storage/spawns/towers/controller container in the home room. When idle in the remote room, they wait near the source to avoid border-tile bouncing.

`CreepMemory.homeRoom` identifies which room a remote creep belongs to. `CreepMemory.targetRoom` tells it which room to operate in. Local miners have neither field set.

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

**When to write tests:** When adding or modifying utility functions, manager logic, or role state machines, add or update corresponding tests. Pure logic (no Screeps runtime dependency) is highest priority. Functions that need only light mocking (mock creep/room) are also good candidates. Skip tests for code tightly coupled to the Screeps runtime (construction placement, error mapping, the main loop). Well-tested modules: `sources.ts`, `remotePlanner.ts`, `roomPlanner.ts`, `scout.ts`, `miner.ts`, `threat.ts`, `body.ts`, `stateMachine.ts`, `spawner.ts`, `labs.ts`, `hauler.ts`, `remoteHauler.ts`, `construction.ts`.

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
