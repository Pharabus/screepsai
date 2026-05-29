# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — Rollup bundles `src/main.ts` into `dist/main.js` + source map.
- `npm run watch` — Rollup in watch mode.
- `npm run deploy` — Bumps patch version, builds, uploads to Screeps via `scripts/deploy.mjs` (reads `SCREEPS_TOKEN` and `SCREEPS_BRANCH` from `.env`).
- `npm run localdeploy` — Bumps patch version and builds only (no upload).
- `npm run lint` — ESLint over `src/`.
- `npm run format` / `npm run format:check` — Prettier.
- `npx tsc --noEmit` — Type-check only.
- `npm test` — Run all Vitest tests (`test/**/*.test.ts`).
- `npm run test:watch` — Vitest in watch mode.
- `npm run test:coverage` — Run tests with V8 coverage report.

Pre-commit hooks (husky + lint-staged) run `prettier --check` and `eslint` on staged `.ts` files automatically.

## Architecture

The AI is a single `loop` function exported from `src/main.ts`, called once per tick by the Screeps runtime. The loop is a linear pipeline of managers, each wrapped in `profile(name, fn)` for per-manager CPU accounting.

### Tick pipeline (order matters)

1. `initMemory()` — one-shot Memory shape init per global reset.
2. `resetTickCache()` / `resetTraffic()` / `resetIdle()` — clears per-tick caches.
3. `runDefense` — scans hostiles, updates threat fields, activates safe mode on perimeter breach. Records hostile intel and logs combat events to `Memory.combatLog`. Runs first so spawner and towers see the same threat view.
4. `runSpawner` — refreshes room plans, selects remote rooms, rebuilds the spawn queue. Bootstrap economy (harvesters) until first source container; then miner economy (miner + hauler + upgrader). Key invariants:
   - Hauler count is distance-scaled per source, **capped at `MAX_HAULERS_PER_SOURCE`** — prevents a distant/swampy source saturating spawning.
   - Builder count is 0 when no construction sites exist (not 1 — that path silently drained energy on fully-built rooms).
   - Defenders prepended dynamically; hunters queued after defenders at Priority 1.
   - Creep counts tracked per `homeRoom` so multi-room colonies don't share quotas.
5. `runLinks` — source links → storage link (primary) / controller link (secondary). Runs before rooms so creeps see fresh link state.
6. `runRooms` — purges dead-creep memory, dispatches each creep via the `roles` registry. Roles register movement intents via `moveTo()` during this phase.
   6b. `resolveTraffic` — resolves tile conflicts by priority and issues `creep.move()` calls.
7. `runTowers` — focus-fires `pickPriorityTarget(room)` (threat-scored, not closest). Falls back to heal → repair. Wall repair uses a per-RCL floor+cap formula (`wallRepairMax` in `towers.ts`). Ramparts on wall tiles are skipped (let them decay — the wall is the barrier).
   7b. `runLabs` — reaction selection (every 500 ticks), runs reactions when inputs loaded. `labFlushing` flag triggers hauler to clear stale minerals before loading new inputs. Boost lab (`boostLabId`) is skipped by the reaction loop.
   7c. `runTerminal` — sells minerals above `MINERAL_TERMINAL_SELL_FLOOR`. **Sell floor must stay below `MINERAL_TERMINAL_CEILING`** — equal values mean the ~5k pinned in storage prevents the terminal portion ever crossing its own line (observed: 23k H stuck unsold). Also runs `sendEnergyToColonies`: ships energy from surplus home rooms to needy colonies, score-sorted with hysteresis to prevent repeat sends on the same route.
   7d. `runFactory` — RCL 7+ only. Compresses energy into batteries when storage > floor and battery stock < cap.
8. `runConstruction` — every 5 ticks. Placement priority: source containers → controller container → storage → links → extensions → towers → roads → corridor roads → remote roads → terminal → factory → extractor → mineral container → labs → ramparts → perimeter walls → perimeter ramparts. Terminal/factory/labs gated behind link completion (builders prioritise energy infra). `layoutPlan.version` invalidates cached layouts on bump.
9. `runVisuals` — opt-in `RoomVisual` overlay, gated by `Memory.visuals`.
10. `flushSegments` — writes dirty `RawMemory.segments` entries.

Reordering has subtle effects: e.g. moving `runSpawner` ahead of `runDefense` lags defender production by a tick.

### Memory model (three layers)

- **`Memory`** — hot, small. Creep roles, room threat fields, profiler stats, combat log, toggles. Keep it small — Screeps JSON-parses it on every first access.
- **`RawMemory.segments` via `src/utils/segments.ts`** — cold/large (room plans, scout reports). Lazy parse, dirty-flag writes. At most 10 active per tick; use `requestSegment(id)`. Segment 5 = neighbor intel.
- **`src/utils/tickCache.ts`** — within-tick memoisation via `cached(key, fn)`. Cleared by `resetTickCache()`.

`src/utils/memoryInit.ts` guarantees `Memory.creeps` / `Memory.rooms` exist after reset.

### Adding a role

1. Create `src/roles/<name>.ts` exporting a `Role` (`run(creep): void`).
2. Define states as a `StateMachineDefinition` and call `runStateMachine(creep, states, defaultState)`.
3. Register in `src/roles/index.ts`.
4. Extend `CreepRoleName` union in `src/types.d.ts`.
5. Add a `SpawnRequest` in `buildSpawnQueue()`. Prefer a dynamic `*Needed(room)` function over a hardcoded count.
6. Set movement priority via `moveTo(creep, target, { priority: PRIORITY_* })`. Stationary roles call `registerStationary(creep, PRIORITY_STATIC)`.

The TypeScript union + `Record<CreepRoleName, Role>` registry means missing any step is a compile error.

### Shared utilities for roles

- **`gatherEnergy(creep)`** (`src/utils/sources.ts`) — shared GATHER state: withdraws from logistics in miner economy, self-harvests in bootstrap. Returns `true` when full.
- **`deliverToSpawnOrExtension(creep)`** / **`deliverToControllerContainer(creep)`** (`src/utils/delivery.ts`) — shared delivery with cross-tick caching. Multiple haulers spread across unclaimed targets to avoid convergence oscillation.
- **`ensureBoosted(creep)`** (`src/utils/boost.ts`) — pre-role boost gate. Returns `false` while routing to a lab for `boostCreep`. **Fails open** (clears `boosts`, returns `true`) when no lab is found — a creep must never stall permanently waiting for a boost. GH2O upgrader boost framework is complete and active in production.
- **`getColonyScore(room)`** (`src/utils/colonyPlanner.ts`) — heap-cached score: `rclFactor × incomeRate × storageFactor`. Higher = worth investing in first. Used by upgrader count gates, colony energy sending, and visuals.
- **Hauler pickup priority** (`src/roles/hauler.ts`): committed target → urgent responder → large dropped energy → lab flush/input/output → storage link → boost-lab service → dropped energy/minerals → ruins/tombstones → source containers → mineral container → factory batteries → terminal minerals. See `hauler.ts` for the full chain and delivery logic (minerals to boost lab / lab input / storage / terminal; drop as last resort on young colonies). **SHELVED: `Memory.haulerPool`** must stay off — pre-assignment via `src/managers/haulerPool.ts` conflicts with task-commitment (committed haulers ignore the assignment) and gave worse convergence in live testing. See `haulerPool.ts` header and `todo.md` Phase 6.

### Body scaling

`buildBody(pattern, energy, maxRepeats?)` in `src/utils/body.ts` scales with `energyCapacityAvailable` — do not hardcode bodies. Specialised builders: `buildMinerBody`, `buildUpgraderBody`, `buildRemoteMinerBody`. Non-production roles capped via `maxRepeats` to control spawning cost.

### Defense

- **Threat scoring** (`src/utils/threat.ts`): HEAL > CLAIM > RANGED_ATTACK > ATTACK > WORK (dead parts ignored). `pickPriorityTarget` weights threat + range-adjusted tower effectiveness — prevents wasting fire on border creeps while closer hostiles roam.
- **Focus-fire is deliberate policy** (`managers/towers.ts`) — closest-target fire lets healers keep attackers alive indefinitely.
- **Safe mode** triggers only when a `threatScore > 0` hostile is within range 5 of a spawn/storage/controller — scouts don't burn a charge.
- **`defendersNeeded`** is tower-aware: returns 0 if energised towers can solo the threat and the enemy can't out-heal tower DPS. Towers fire regardless; this removes redundant spawn cost only.
- **`defenderComposition`** (`src/managers/spawner.ts`) — returns `{ melee, ranged, healer }` counts by threat band, capped at 4 total.
- **`src/utils/neighbors.ts`** — records hostile player intel in segment 5. Players classified `aggressive` cause remote planner to reject their observed rooms for 20k ticks.
- **Hunter role** (`src/roles/hunter.ts`) — clears NPC Invaders from remote/transit rooms. Targets `'Invader'` owner only; never engages players. TRAVEL state waits for `isInRoomInterior` before transitioning to HUNT — prevents work starting on a border tile the engine auto-evicts. Priority 1, one per infested room.
- **Perimeter defense** (`src/utils/perimeterPlanner.ts`) — BFS flood-fill from exits defines the perimeter. Walls on non-gate tiles; ramparts on gate tiles. Gate targets: sources outside core, distant controller, one per remote room exit direction. `getPlannedReserved()` includes wall tiles so road pathfinding routes through gates. Stored in `RoomMemory.perimeterPlan`.
- **Combat log** (`src/utils/combatLog.ts`) — ring buffer in `Memory.combatLog`. Console: `combatLog()`.

### Profiling & visuals (opt-in)

- `Memory.profiling = true` → `profile(name, fn)` records CPU EMA in `Memory.stats`.
- `Memory.visuals = true` → per-room headers, storage level, controller progress, idle creep indicators.
- `Memory.profileOverlay = true` (requires visuals) → sorted CPU table overlay on first owned room.

Wrap new managers/hot paths in `profile('label', fn)`. Console exports: `stats()`, `resetStats()`, `status()`, `replanLayout(roomName)`, `replanPerimeter(roomName)`, `combatLog()`, `neighbors()`, `suggestSpawn(roomName)`. Add new commands as `export const` in `main.ts` and register on `global`.

### Creep state machine

All roles use `src/utils/stateMachine.ts`. Each `StateHandler.run(creep)` returns a state name to transition or `undefined` to stay. State persisted in `creep.memory.state`. Falls back to default on rename (safe deploy). `onEnter()` called on transition.

### Movement & traffic

- **Always use `moveTo()`** from `src/utils/movement.ts` — never `creep.moveTo()` or `creep.move()` directly.
- CostMatrix (`src/utils/trafficManager.ts`): roads=1, moving creeps=**0** (not soft-avoid — cost-50 inflated corridors near idle hauler clusters, pushing PathFinder onto longer detours), stationary/hostile/impassable=255. Stuck-detection repath still uses cost-50 so recovery paths route around active blockers.
- **Active blocker pushing** (`pushBlocker`): nudges a lower-priority creep off the next tile. Best-effort, one push per tick per creep.
- **Stuck detection**: repath at 2 ticks stuck; force-repath with cache invalidation at 3 ticks, retry every 3.
- Room callback skips unseen rooms owned by other players — avoids pathing into enemy tower range.
- Pass `range: 0` when the role must stand on a specific tile (default range is 1).
- **`isInRoomInterior(creep)`** — true when ≥3 tiles from every border edge. Use in TRAVEL states: border-tile creeps can be auto-evicted by the engine.

### Remote mining

1. `scout` (1 MOVE) records source count, ownership, hostile presence, and source positions. Spawned only when below the storage-gated remote cap — no permanent scout.
2. `selectRemoteRooms()` (`src/utils/remotePlanner.ts`) — rejects owned/player-reserved/hostile rooms; picks best by source count up to a storage-gated cap with hysteresis to prevent churn near the threshold.
3. `ensureRemoteRoomPlan()` — scans visible remote sources; bootstraps from `scoutedSourceData` when dark.
4. Remote miners reuse the `miner` role with `targetRoom` set. They have 1 CARRY to build/repair their container. Pre-spawned `REMOTE_MINER_PRESPAWN_TICKS` before predecessor TTL to avoid coverage gaps.
5. `remoteHauler` picks up energy from the remote room, delivers home. Delivers `RESOURCE_ENERGY` **only** — picking up non-energy minerals would trap them in the hauler permanently.
6. `reserver` (`[CLAIM×2, MOVE×2]`) — 1 per remote room with a controller; net +1 reservation/tick doubles source capacity.
7. `remoteBuilder` — builds/repairs remote roads. Temporary; stops spawning when roads are built and healthy.

`CreepMemory.homeRoom` = owner room. `CreepMemory.targetRoom` = operating room. Local miners have neither.

### Idle creep management

`src/utils/idle.ts` — `markIdle(creep)` registers idle state, parks creeps away from the spawn cluster (deterministic per-name offset), and recycles chronically idle creeps. Builders/repairers/upgraders never idle. Haulers **do not recycle** — the old recycle threshold churned haulers during normal idle gaps, costing more energy than it saved.

### Deployment

`scripts/deploy.mjs` POSTs `dist/main.js` to Screeps API with `X-Token` auth. Config in `.env` (gitignored). `npm run deploy` auto-bumps patch version; build stamps a version banner on line 1 of the bundle.

### Error mapping

`src/utils/ErrorMapper.ts` wraps the loop with a synchronous VLQ decoder (not `source-map` — it's async/too slow) to map runtime errors to TypeScript source lines. Map cached across ticks, rebuilt on global reset.

## Testing

Tests in `test/` mirror `src/`. Vitest with `globals: true`. `test/mocks/screeps.ts` provides `mockCreep()`, `mockRoom()`, `resetGameGlobals()` — call `resetGameGlobals()` in `beforeEach` when tests mutate `Game` or `Memory`. `RawMemory` is also stubbed; call `flushSegments()` between fake ticks when exercising segment-backed utilities.

**When to write tests:** utility functions and manager logic — yes. Pure logic (no Screeps runtime dependency) is highest priority. Skip code tightly coupled to the runtime. Export internal functions to make them testable.

## TypeScript / Screeps specifics

- `strict` + `noUncheckedIndexedAccess` — `Game.creeps[name]` returns `T | undefined`, always null-check.
- `lib: ES2021`, no DOM. Do not add `@types/node`.
- Do not import `lodash` — use native array methods (lodash is a global but was deliberately cleaned up).
- Rollup outputs CJS (`"type": "commonjs"`). Screeps VM is CJS.
- Screeps IVM uses `global` (not `globalThis`). Minimal globals (`console`, `require`, `global`, `module`) declared in `src/types.d.ts`.

## Source of truth

`README.md` covers architecture at more length. `todo.md` tracks outstanding work in priority order — check it before starting anything ambitious.

## Engineering lessons

1. **External insights don't always translate** — understand *why* something works elsewhere before porting; context beats the idea.
2. **Live validation is ground truth** — unit tests pass and it still breaks; the Screeps environment surfaces edges no mock captures.
3. **Feature flags are worth the boilerplate** — ship dormant, test safely, shelve without reverting; shelved code must explain *why* it's off and what it conflicts with.
4. **Respect existing architectural invariants** — understand what a system already solves before replacing it.
5. **Measure before optimising** — "looks bad visually" is not evidence; define a proxy metric first.
6. **Complexity has a carrying cost** — a simpler slightly-suboptimal system usually beats a theoretically better complex one.
7. **Emergent solutions can be more robust** — task-commitment outperformed a designed dispatch system; understand emergent behaviour before replacing it.
8. **Annotate shelved code thoroughly** — the comment is the only thing preventing re-implementing the same mistake; include what, why, what it conflicts with, and where to look.
