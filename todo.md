# Screeps AI - TODO

## Build & Tooling

- [x] **Replace Rollup with a modern bundler** - The `rollup.config.js` uses CJS `require`-style config but the project has `"type": "commonjs"`. Consider switching to `esbuild` or `swc` for faster builds and simpler config. If staying with Rollup, rename to `rollup.config.mjs` or use ESM properly.
- [x] **Fix `package.json` build script** - `"build": "tsc"` compiles with `tsc` but the project has a Rollup config that never gets invoked. Should be `"build": "rollup -c"` to actually bundle.
- [x] **Add a `.gitignore`** - No `.gitignore` exists. At minimum ignore `node_modules/`, `dist/`, and `*.js.map`.
- [x] **Add linting** - No ESLint or Biome config. Add `@typescript-eslint` or Biome for consistent code quality and catching Screeps-specific pitfalls.
- [x] **Add Prettier formatting** - Added Prettier with `.prettierrc` config and `format`/`format:check` scripts.
- [x] **Pin Node version** - Added `.nvmrc` (22) and `engines: { node: ">=20" }` in `package.json`.
- [x] **Add a deploy script** - Wired up `screeps-api upload` in the deploy script.
- [x] **Add a watch mode** - Added `"watch": "rollup -c -w"` script.
- [x] **Remove unused `ts-node` dependency** - Removed `ts-node`, `@types/source-map`, and `@types/node`.
- [x] **Remove `source-map` dependency** - Removed entirely. ErrorMapper now uses a custom synchronous VLQ decoder instead.

## TypeScript Configuration

- [x] **Bump `target` to `ES2021`** - Updated target and lib to ES2021.
- [x] **Remove `"dom"` from `lib`** - Replaced with `ES2021`. Added `console` declaration to `types.d.ts` for the Screeps global.
- [x] **Remove `"node"` from `types`** - Removed from tsconfig. Added a targeted `declare function require` in `types.d.ts` for the Screeps-specific require that ErrorMapper uses.
- [x] **Set `"isolatedModules": true`** - Enabled for bundler compatibility.
- [x] **Enable `"noUncheckedIndexedAccess": true`** - Enabled. Fixed all resulting type errors in `main.ts` (null-checked `Game.creeps[name]` and `sources[0]`) and `ErrorMapper.ts` (nullish coalescing on regex match groups).

## ErrorMapper (`src/utils/ErrorMapper.ts`)

- [x] **Fix async misuse** - Rewrote entirely: replaced async `source-map` library with a synchronous VLQ decoder. Errors now log immediately in the same tick. Removed the `source-map` dependency entirely (bundle dropped from 3266 to 201 lines).
- [x] **Remove `catch (e: any)` in `wrapLoop`** - Changed to `catch (e: unknown)` with proper narrowing.
- [x] **Eliminate redundant variable** - Removed `const err = e;`, using `e` directly.
- [x] **Cache invalidation** - Source map is cached with `Game.time` tracking. Cache persists across ticks but is rebuilt on global reset (new code deploy).
- [x] **Remove the `require("main.js.map")` pattern** - Still uses `require('main.js.map')` for loading (only way in Screeps), but removed the fragile async `SourceMapConsumer.with()` wrapper. The raw JSON is now parsed directly and synchronously.

## Architecture & Code Structure

- [x] **Extract creep roles into separate modules** - Created `src/roles/Role.ts` (interface), `src/roles/harvester.ts`, and `src/roles/index.ts` (registry). Harvester now also delivers to extensions and towers, not just spawn.
- [x] **Create a role registry/dispatcher** - `src/roles/index.ts` exports a `Record<CreepRoleName, Role>` registry. Room manager dispatches via `roles[creep.memory.role].run(creep)`.
- [x] **Use a string literal union for `CreepMemory.role`** - Added `type CreepRoleName = 'harvester' | 'upgrader' | 'builder'` in `types.d.ts`. `CreepMemory.role` now uses this type. The role registry is typed against it so adding a new role name requires a matching implementation.
- [x] **Remove the lodash import** - Replaced `_.filter()` with `Object.values().filter()`. Removed `@types/lodash` devDependency.
- [x] **Remove hardcoded `'Spawn1'` references** - Spawner uses `Object.values(Game.spawns).find(s => !s.spawning)` to pick any available spawn. Harvester delivers to any spawn/extension/tower with capacity.
- [x] **Extract spawn logic** - Created `src/managers/spawner.ts` with a `spawnQueue` array (priority-ordered spawn requests with role, body, and min count). Easy to extend with new roles and dynamic body composition.
- [x] **Add a room manager abstraction** - Created `src/managers/room.ts` encapsulating memory cleanup and creep dispatch. Main loop is now just `runSpawner()` + `runRooms()`.

## Gameplay Expansion

- [x] **Add upgrader role** - `src/roles/upgrader.ts`. Harvests energy then upgrades the room controller.
- [x] **Add builder role** - `src/roles/builder.ts`. Builds construction sites, falls back to upgrading when none exist.
- [x] **Add repairer role** - `src/roles/repairer.ts`. Repairs structures below 75% health (excluding walls), falls back to upgrading.
- [x] **Add dynamic body composition** - `src/utils/body.ts` `buildBody()` repeats a body pattern up to the room's `energyCapacityAvailable`. Spawner uses it for all roles — creeps scale automatically as extensions are built.
- [x] **Add energy source balancing** - `src/utils/sources.ts` picks the source with fewest nearby creeps, breaking ties by distance. All four roles use `harvestFromBestSource()`.
- [x] **Add tower management** - `src/managers/towers.ts` runs all towers with priority: attack hostiles > heal friendlies > repair (only when above 50% energy). Walls/ramparts capped at 10k hits to conserve energy.
- [x] **Add construction automation** - `src/managers/construction.ts` auto-places extensions, towers, and roads based on RCL limits. Roads are pathed from spawn to sources and controller. One placement per tick to stay within CPU.
- [x] **Add defense logic** - Full stack in place: (1) `src/utils/threat.ts` scores hostiles by body parts (HEAL 250 > CLAIM 200 > RANGED_ATTACK 150 > ATTACK 80 > WORK 30, dead parts ignored) and exposes `pickPriorityTarget(room)`; (2) `src/managers/towers.ts` rewritten so every tower in a room focus-fires the same highest-threat target, so healers die before they can negate incoming damage; (3) `src/managers/defense.ts` auto-activates safe mode when a threat-scoring hostile enters range 5 of a spawn / storage / controller and safe mode is available; (4) `src/roles/defender.ts` is a new `[ATTACK, MOVE]` role that chases the priority target and rallies near the spawn when idle; (5) `spawner.ts` now builds its queue per tick via `buildSpawnQueue()` and prepends a `defender` request with `minCount = min(ceil(threatScore/200), 4)` while `defendersNeeded(room) > 0`, with a 50-tick memory window so brief loss-of-sight doesn't cancel spawns. `runDefense` runs before `runSpawner` and `runTowers` in `main.ts` (profiled). `RoomMemory` gained `threatLastSeen` / `lastThreatScore`.

### Non-Energy Resource Harvesting (Minerals, Deposits, Commodities, Power)

The current AI only harvests energy from Sources. Screeps has four other harvestable/produced resource classes, each unlocking at a specific RCL and requiring matching logistics. Work items are RCL-gated so construction/spawning is not wasted.

#### Gating summary (by RCL)

| RCL | Unlocks                                       | Resource goal                                   |
|-----|-----------------------------------------------|-------------------------------------------------|
| 4   | Storage                                       | Central stockpile (prereq for everything below) |
| 6   | Extractor, Terminal, Labs (3)                 | Mineral mining + lab reactions + market         |
| 7   | Factory, more Labs (6)                        | Commodity production                            |
| 8   | Power Spawn, Observer, full labs (10), nuker  | Power processing + deposit mining at scale      |

Deposit mining (highway surfaces) is technically possible earlier but is only economical once we have a Factory (RCL 7) to refine commodities from them, so gate it there.

#### Plan

- [ ] **Extend `CreepRoleName` and memory for non-energy resources** — Add role names (`miner`, `hauler`, `depositMiner`, `powerMiner`, `powerHealer`, `powerHauler`) and extend `CreepMemory` with optional fields (`targetId`, `resource: ResourceConstant`, `home: string`, `assignedSourceId`). Update `src/types.d.ts` and `src/roles/index.ts`.
- [ ] **Generalise `buildBody` callers for non-`[WORK, CARRY, MOVE]` patterns** — Introduce per-role body builders (e.g. mineral miner = heavy WORK + MOVE, hauler = CARRY + MOVE, power miner = ATTACK + MOVE with healer escort). Keep the generic `buildBody` util; add role-specific `chooseBody(room, role)` helpers.
- [ ] **RCL-gated construction planner extensions** — Extend `src/managers/construction.ts` with placement for: container under mineral, extractor on mineral (RCL 6), terminal near storage (RCL 6), factory (RCL 7), labs cluster (RCL 6+, expand at 7 and 8), power spawn + observer (RCL 8). Add `MAX_*` maps and `place*` functions mirroring the existing extension/tower pattern.
- [ ] **Room memory & planning layer** — Introduce per-room memory (`Memory.rooms[name]`) holding planned structure positions, assigned creep counts per task, and cached mineral/source IDs so we don't re-scan every tick.

##### Stage 1 — Storage + hauler logistics (RCL 4)

- [ ] **Place a Storage near the spawn** — Add to the construction manager at RCL ≥ 4. This is a prerequisite for mineral / commodity / power stockpiles.
- [ ] **Add a `hauler` role** — `[CARRY, MOVE]` bodies. Pulls from containers (or dropped piles) and delivers to spawn/extensions/towers/storage. Frees harvesters to become static container miners.
- [ ] **Static `miner` role for energy sources** — `[WORK, WORK, WORK, WORK, WORK, MOVE]` style body (5 WORK fully drains a source on cooldown). Requires a container under each source; the hauler empties it. This is the efficient logistics pattern and also the template for mineral mining.
- [ ] **Container placement on source paths** — Extend `construction.ts` to drop a container adjacent to each source (1 tile away, on the road path to spawn).

##### Stage 2 — Mineral mining (RCL 6)

- [ ] **Place Extractor + Container on the room's mineral** — Single mineral per room, `room.find(FIND_MINERALS)[0]`. Extractor on top, container 1 tile away. Gate on RCL ≥ 6.
- [ ] **Add `mineralMiner` role** — Heavy WORK body. Checks `mineral.mineralAmount > 0` and `mineral.ticksToRegeneration` before harvesting (minerals have cooldowns and can deplete for ~50k ticks). Stands on the container tile.
- [ ] **Teach hauler about mineral containers** — Hauler should drain the mineral container into the Storage, then Storage → Terminal when storage threshold is hit.
- [ ] **Place Terminal** — Required for market trading and cross-shard transfers. Construction manager at RCL ≥ 6.
- [ ] **Basic terminal policy** — If storage has > N of a mineral, push excess into the terminal. Stub for later market sell orders.

##### Stage 3 — Labs & boosts (RCL 6 → 8)

- [ ] **Lab cluster placement** — Plan 10 labs in a compact cluster (2 input labs + 8 output labs, all within range 2 of each other). Place 3 at RCL 6, 6 at RCL 7, 10 at RCL 8.
- [ ] **Lab manager** — `src/managers/labs.ts`. Given a target reaction (e.g. `UH` → `UH2O`), moves inputs from terminal into input labs via hauler, runs `lab.runReaction`, and cycles outputs back to storage.
- [ ] **Boost application (stretch)** — Designate combat/upgrader creeps to be boosted before departing spawn. Out of scope for the first pass.

##### Stage 4 — Commodity production (RCL 7)

- [ ] **Place Factory** — Construction manager at RCL ≥ 7. Placed adjacent to storage + terminal.
- [ ] **Add `factoryManager`** — `src/managers/factory.ts`. Pick a target commodity from a configurable list, check inputs in storage/terminal, haul in via hauler, run `factory.produce`, push outputs back. Level the factory (0–5) based on inputs we can sustain.

##### Stage 5 — Deposit mining (RCL 7+, highway rooms)

- [ ] **Scout highway rooms for deposits** — Use Observer (RCL 8) or scout creeps (1 MOVE) to find `FIND_DEPOSITS`. Track `lastCooldown` per deposit — abandon when cooldown exceeds a threshold (e.g. 100).
- [ ] **Add `depositMiner` + dedicated hauler** — Deposit miners harvest until cooldown climbs, then return; haulers shuttle the resource back to a home-room terminal. Bodies need enough MOVE to handle remote travel at 1:1 fatigue on roadless terrain.
- [ ] **Feed deposit output into the factory** — Deposits produce commodity inputs (silicon, biomass, metal, mist). Factory manager consumes them at level-appropriate recipes.

##### Stage 6 — Power mining (RCL 8)

- [ ] **Place Power Spawn** — Construction manager at RCL 8, adjacent to storage (needs energy + power input).
- [ ] **Scan highway rooms for Power Banks** — Via Observer. Filter by `power >= 2000`, `ticksToDecay >= 3000`, and 2+ free adjacent tiles (banks need multiple attackers).
- [ ] **Power squad: `powerAttacker` + `powerHealer` + `powerHauler`** — Attacker is pure ATTACK + MOVE; healer sticks on range 1 with HEAL + MOVE; hauler arrives as the bank breaks to scoop the drop and run it home. All three scale bodies to room `energyCapacityAvailable`.
- [ ] **Power processing loop** — Once power is in storage, feed `powerSpawn.processPower()` (100 energy + 1 power per call, up to 50/tick) to convert into global power level (GPL).

##### Cross-cutting

- [ ] **Per-resource stockpile thresholds in Memory** — Configurable floors/ceilings for each resource in storage/terminal; managers read these to decide whether to produce, sell, or transfer.
- [ ] **Market stub** — When terminal has surplus above ceiling, place sell orders (or fulfil existing buy orders) via `Game.market`. Start read-only (logging) and only enable trading when thresholds are stable.
- [ ] **Unit tests for RCL gating** — Mock `room.controller.level` and assert each construction/spawn decision fires only at the intended RCL.

- [ ] **Add multi-room support** - Scout, claim, and manage remote rooms for resource harvesting.
- [ ] **Add resource logistics** - Hauler creeps, container mining, link networks, terminal trading.
- [ ] **Add a state machine or behaviour tree for creeps** - Replace simple if/else logic with a proper decision framework that's easier to extend and debug.
- [x] **Add memory serialisation optimisation** - Added three pieces of infrastructure so growing persistent data doesn't balloon the per-tick `Memory` parse cost: (1) `src/utils/tickCache.ts` transient per-tick memoisation (cleared at loop start; `spawner` now tallies creep counts by role once per tick instead of once per queue entry); (2) `src/utils/segments.ts` typed wrapper over `RawMemory.segments` with lazy parse on read, dirty-tracked writes (only mutated segments serialise at flush), and `requestSegment` queuing for next-tick availability — use for cold/large data like room plans, scout reports, stats; (3) `src/utils/memoryInit.ts` one-shot per-global-reset initialisation of `Memory.creeps` / `Memory.rooms` shape so hot-path code can skip defensive `??= {}` branches. `main.ts` now wraps the tick with `initMemory` + `resetTickCache` at the top and `flushSegments` at the bottom. `Memory` and `RoomMemory` typings added in `types.d.ts`.
- [x] **Add profiling/stats** - `src/utils/profiler.ts` exposes `profile(name, fn)` which folds CPU samples into exponential moving averages stored in `Memory.stats` (one slot per label, bounded footprint). Each manager (`spawner`, `rooms`, `towers`, `construction`, `visuals`) plus `main.loop` is wrapped in `main.ts`, and per-creep dispatch in `managers/room.ts` is labelled `role.<roleName>` so hot roles surface separately. Console globals `stats()` (sorted table) and `resetStats()` are installed once per global reset. Gated by `Memory.profiling` — production ticks pay ~nothing when disabled.
- [x] **Add visual debugging** - `src/managers/visuals.ts` runs once per tick under `profile('visuals', …)`, gated by `Memory.visuals` so it costs nothing when off. For each owned room draws: header with RCL + energy + creep counts by role, last-tick CPU usage, and source-load markers (how many creeps are within range 2 of each source — red when nothing is mining a source). Easy to extend with additional overlays later.

## Testing & Quality

- [ ] **Add unit tests** - Use Vitest or Jest with mocked Screeps globals to test role logic, spawn decisions, etc.
- [ ] **Add a CI pipeline** - GitHub Actions or similar to run `tsc --noEmit`, lint, and tests on every push.
- [ ] **Add pre-commit hooks** - Use `husky` + `lint-staged` to run type-checking and linting before commits.
