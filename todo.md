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

- [x] **Extend `CreepRoleName` and memory for energy logistics** — Added `miner` and `hauler` to `CreepRoleName`. Extended `CreepMemory` with `targetId`, `working`. Extended `RoomMemory` with `sources[]` (id, containerId, minerName), `controllerContainerId`, `minerEconomy`. Remaining non-energy roles (`depositMiner`, `powerMiner`, `powerHealer`, `powerHauler`) and fields (`resource`, `home`) deferred to later stages.
- [x] **Per-role body patterns in spawner** — Spawner now uses role-specific patterns: miner `[WORK×5, MOVE]`, hauler `[CARRY×2, MOVE×2]`, upgrader `[WORK×3, CARRY, MOVE×2]`, builder `[WORK×2, CARRY, MOVE×2]` in miner economy. Bootstrap economy retains `[WORK, CARRY, MOVE]` for all roles. `buildBody` util unchanged; patterns passed per-role via the spawn queue.
- [x] **RCL-gated construction planner extensions (RCL 5-6)** — Added `placeLinks` (RCL 5+: storage link, source links, controller link at RCL 6), `placeExtractor` + `placeMineralContainer` (RCL 6), `placeTerminal` (RCL 6). Remaining: factory (RCL 7), labs cluster (RCL 6+), power spawn + observer (RCL 8).
- [ ] **RCL-gated construction planner extensions (RCL 7-8)** — Factory (RCL 7), labs cluster (RCL 6+, expand at 7 and 8), power spawn + observer (RCL 8).
- [x] **Room memory & planning layer** — `src/utils/roomPlanner.ts` caches source IDs, container assignments, miner assignments, and controller container ID into `RoomMemory`. `ensureRoomPlan(room)` validates each tick (cheap after first scan). Auto-detects miner economy transition when first source container is built.

##### Stage 1 — Storage + hauler logistics (RCL 4)

- [x] **Place a Storage near the spawn** — Added `placeStorage(room)` at RCL ≥ 4. Uses `findOpenPosition` 2–4 tiles from spawn.
- [x] **Add a `hauler` role** — `src/roles/hauler.ts`. `[CARRY×2, MOVE×2]` body. Picks up from source containers (fullest first) or dropped piles, delivers to spawn/extensions/towers/controller container/storage with priority ordering. Uses `working` toggle.
- [x] **Static `miner` role for energy sources** — `src/roles/miner.ts`. `[WORK×5, MOVE]` body. Assigned a source via `roomPlanner.findUnminedSource`, moves to its container tile and harvests indefinitely. 5 WORK fully drains the source per regen cycle.
- [x] **Container placement on source paths** — `placeSourceContainers(room)` at RCL ≥ 2. Places on first path step from source toward spawn (adjacent to source, on road). Also added `placeControllerContainer(room)` within range 2 of controller for upgraders.

##### Stage 1.5 — Link network (RCL 5)

- [x] **Link construction placement** — `placeLinks(room)` places storage link (receiver, priority), source links (sender, most distant first), controller link (RCL 6+). `MAX_LINKS` table. Room planner discovers and caches link IDs with source/storage/controller link disambiguation.
- [x] **Link manager** — `src/managers/links.ts` `runLinks()` transfers energy from source links to storage link (primary) or controller link (secondary). Runs after spawner, before rooms in tick pipeline.
- [x] **Miner link integration** — Miner transfers energy to adjacent link after harvesting (requires CARRY parts). Falls back to container overflow if link is full.
- [x] **Hauler link integration** — Hauler empties storage link as highest-priority pickup (after dropped resources). Hauler count reduced for linked sources (1 hauler vs 2-3 for unlinked).
- [x] **Miner body scaling** — Pattern changed to `[WORK,WORK,CARRY,MOVE]` x3 (was `[WORK,WORK,MOVE]` x3). CARRY enables link transfers. 6W fully saturates source at 800+ capacity.

##### Stage 2 — Mineral mining (RCL 6)

- [x] **Place Extractor + Container on the room's mineral** — `placeExtractor(room)` places `STRUCTURE_EXTRACTOR` on mineral at RCL 6+. `placeMineralContainer(room)` places container adjacent to mineral. Room planner discovers mineral ID and container.
- [x] **Add `mineralMiner` role** — `src/roles/mineralMiner.ts`. Stands on mineral container, harvests when `mineralAmount > 0`. Body: `[WORK,WORK,MOVE]` x5. Spawned at low priority when extractor built + container exists + mineral not depleted.
- [x] **Teach hauler about mineral containers** — Hauler picks up non-energy resources from mineral container and delivers directly to storage (skipping spawn/extensions/towers).
- [x] **Place Terminal** — `placeTerminal(room)` at RCL 6+, within 1-3 tiles of storage.
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
- [x] **Unit tests for RCL gating** — 16 tests across 12 describe blocks in `test/managers/construction.test.ts`. Each `place*` function tested for correct RCL gating (e.g. extensions at RCL 2+, towers at RCL 3+, storage at RCL 4+, links at RCL 5+, terminal/extractor/mineral at RCL 6+).

- [x] **Builder/repairer logistics integration** - Both roles now check `minerEconomy` and withdraw from source containers (closest, >100 energy) or storage before falling back to self-harvest. Shared `withdrawFromLogistics()` utility in `src/utils/sources.ts`. Bootstrap mode unchanged.
- [x] **Upgrader count scales with storage surplus** - `upgradersNeeded()` now adds bonus upgraders based on `room.storage` energy: >50k = +1, >200k = +2, >500k = +3. Additive to the existing capacity-based count.
- [x] **Roads to storage** - `placeRoads()` now includes `room.storage.pos` in its road targets when storage exists.
- [x] **Hauler storage withdrawal guard** - Haulers only withdraw from storage when spawn/extensions or towers (below 75%) need energy. Prevents draining storage to fill controller container.
- [ ] **Storage withdrawal guard for builders/repairers/upgraders** — `withdrawFromLogistics()` (used by builder/repairer) and the upgrader's GATHER state both withdraw from storage unconditionally if it has any energy. Unlike the hauler (which checks for downstream need first), these roles can drain storage to zero, starving spawning. Add a floor threshold (e.g. only withdraw from storage when energy > 10k) so a minimum reserve is maintained for spawns and hauler redistribution.
- [x] **Clustered extension placement** - Extensions now use a stamp pattern (`EXTENSION_STAMP` in construction.ts) instead of ring scanning. Compact diamond layout leaving road corridors on dx=0/dy=0 axes. Falls back to `findOpenPosition()` if all stamp cells are terrain-blocked.
- [x] **Rampart placement on critical structures** - `placeRamparts()` at RCL ≥ 3 places ramparts on spawns, towers, and storage. One per tick. Towers already repair ramparts (capped at 10k hits).
- [x] **Wall/rampart repair scaling** - `wallRepairMax(room)` replaces hardcoded 10k cap. Scales with storage energy (stored × 0.5) clamped to per-RCL caps: 3=10k, 4=50k, 5=300k, 6=1M, 7=5M, 8=50M. Cached per room per tick.
- [x] **CPU optimizations** - Construction runs every 5 ticks instead of every tick. Tower repair target cached per room (shared across towers). `status()` console command shows link info.
- [x] **Dynamic spawn counts for all roles** - All role counts in `spawner.ts` are now computed per-room per-tick via `*Needed(room)` functions: `buildersNeeded` scales 1–3 by `ceil(constructionSites / 3)`, `repairersNeeded` scales 1–2 when >5 structures below 75% HP, `upgradersNeeded` scales 1–3 by room energy capacity, `haulersNeeded` 2–3 per source container, `minersNeeded` 1 per container without a miner, `defendersNeeded` by threat score. No hardcoded minimums except bootstrap harvesters (2) and emergency miner-economy harvester (1). Idle builders/repairers fall back to upgrading.
- [x] **Add multi-room support (remote mining)** - Scout role explores adjacent rooms and records source positions, remote planner evaluates/selects up to 2 best rooms (tolerates stale hostile sightings), miners reuse existing role with cross-room PathFinder pathing to stored source positions, remote miners self-build containers at remote sources, dedicated remoteHauler role for cross-room energy transport with full delivery chain (storage/spawns/towers/controller container), builder construction priority (extensions before storage). Expandable to claiming later.
- [x] **Remote container repair** — Remote haulers repair their source container when it drops below 50% HP. They already carry energy and idle near the source between pickups, so a quick `repair()` check before pickup keeps containers alive without needing a dedicated repairer. Prevents the decay → rebuild cycle where the miner wastes CARRY on building and energy is lost from destroyed containers.
- [ ] **Multi-room future: claiming** - `remoteRooms` needs a type field (`remote` | `reserved` | `claimed`). Controller reservation creep (CLAIM body) to double remote source output. `countCreepsByRole()` is global — needs per-room counting when claiming a second room with its own spawner. Remote container placement once reserved. Remote defense policy (flee vs defend). Remote road building for hauler efficiency.
- [x] **Add resource logistics (phase 1)** - Static miner + hauler + container mining economy with automatic transition from bootstrap. Link networks and terminal trading deferred to later stages.
- [x] **Add a state machine for creeps** - All 8 roles use `src/utils/stateMachine.ts` FSM. Each role defines named states (`GATHER`/`WORK`, `PICKUP`/`DELIVER`, `POSITION`/`HARVEST`, `ATTACK`/`RALLY`) with explicit transitions. State persists in `creep.memory.state` for in-game debugging. `onEnter` hooks handle cleanup on transition.
- [x] **Add a traffic manager** - `src/utils/trafficManager.ts` collects movement intents from all creeps during `runRooms`, then `resolveTraffic()` resolves conflicts. Priority-based: STATIC (100, miners) > HAULER (50) > WORKER (30) > DEFAULT (10). Handles swap detection, idle creep shoving, and alternative tile selection. CostMatrix cached per room per tick. Replaces the old `ignoreCreeps: true` approach. `moveTo()` wrapper registers intents instead of calling `creep.moveTo()` directly.
- [x] **Simplify traffic manager** - The current intent-based solver (~200 lines) has an incomplete world model: it only tracks creeps that register intents, so idle/unmanaged creeps become invisible obstacles. This causes cascading bugs (frozen columns, orphaned creeps blocking paths) that required swap detection, cycle breaking, idle shoving, and stuck fallback patches. **Planned replacement**: strip down to "soft" traffic management — (1) stationary claims only (miners keep tiles via CostMatrix 255), (2) creep positions as CostMatrix cost 15 (discourages routing through clusters but doesn't hard-block), (3) each creep calls `creep.move(direction)` directly from its PathFinder result instead of registering intents, (4) stuck fallback (already implemented — native `creep.moveTo` with `reusePath: 0` after 3 ticks stuck). Remove: the greedy tile-claiming loop, swap detection, cycle breaking, idle shoving, `tryAlternative`. Target ~60 lines. The Screeps engine handles 2-way swaps natively, so explicit swap logic is unnecessary when creeps move independently.
- [x] **Add memory serialisation optimisation** - Added three pieces of infrastructure so growing persistent data doesn't balloon the per-tick `Memory` parse cost: (1) `src/utils/tickCache.ts` transient per-tick memoisation (cleared at loop start; `spawner` now tallies creep counts by role once per tick instead of once per queue entry); (2) `src/utils/segments.ts` typed wrapper over `RawMemory.segments` with lazy parse on read, dirty-tracked writes (only mutated segments serialise at flush), and `requestSegment` queuing for next-tick availability — use for cold/large data like room plans, scout reports, stats; (3) `src/utils/memoryInit.ts` one-shot per-global-reset initialisation of `Memory.creeps` / `Memory.rooms` shape so hot-path code can skip defensive `??= {}` branches. `main.ts` now wraps the tick with `initMemory` + `resetTickCache` at the top and `flushSegments` at the bottom. `Memory` and `RoomMemory` typings added in `types.d.ts`.
- [x] **Add profiling/stats** - `src/utils/profiler.ts` exposes `profile(name, fn)` which folds CPU samples into exponential moving averages stored in `Memory.stats` (one slot per label, bounded footprint). Each manager (`spawner`, `rooms`, `towers`, `construction`, `visuals`) plus `main.loop` is wrapped in `main.ts`, and per-creep dispatch in `managers/room.ts` is labelled `role.<roleName>` so hot roles surface separately. Console globals `stats()` (sorted table) and `resetStats()` are installed once per global reset. Gated by `Memory.profiling` — production ticks pay ~nothing when disabled.
- [x] **Add visual debugging** - `src/managers/visuals.ts` runs once per tick under `profile('visuals', …)`, gated by `Memory.visuals` so it costs nothing when off. For each owned room draws: header with RCL + energy + creep counts by role, last-tick CPU usage, and source-load markers (how many creeps are within range 2 of each source — red when nothing is mining a source). Easy to extend with additional overlays later.

## Testing & Quality

- [x] **Add unit tests** - Vitest with hand-rolled Screeps mocks (`test/mocks/screeps.ts`). 48 tests covering `buildBody`, `tickCache`, `stateMachine`, `threatScore`/`pickPriorityTarget`, and `spawner` (buildSpawnQueue, minersNeeded, haulersNeeded, upgradersNeeded). Run via `npm test`, watch mode via `npm run test:watch`, coverage via `npm run test:coverage`.
- [x] **Add a CI pipeline** - GitHub Actions (`.github/workflows/ci.yml`) runs tsc, lint, format:check, test, and build on push/PR to main.
- [x] **Add pre-commit hooks** - husky + lint-staged runs `prettier --check` and `eslint --max-warnings=0` on staged `.ts` files. `tsc --noEmit` only in CI (too slow for pre-commit).
