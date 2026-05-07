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
- [ ] **RCL-gated construction planner extensions (RCL 7-8)** — Factory (RCL 7), power spawn (RCL 8), observer (RCL 8), nuker (RCL 8). Labs already handled (expand at 7 and 8 via `MAX_LABS` table). See Stage 4 (factory), Stage 6 (power), and Advanced defense / Offensive sections for detailed plans.
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
- [x] **Basic terminal policy** — Hauler delivers non-energy resources to terminal (preferred) or storage. When idle, moves excess minerals from storage (above 5k floor) to terminal. `src/managers/terminal.ts` stub runs every 10 ticks for future market sell orders.

##### Stage 3 — Labs & boosts (RCL 6 → 8)

- [x] **Lab cluster placement** — `placeLabs(room)` uses a stamp pattern (`LAB_STAMP` in `construction.ts`) anchored +2 tiles from storage. 10 positions where all output labs are within Chebyshev range 2 of both input labs. Places 3 at RCL 6, 6 at RCL 7, 10 at RCL 8. Room planner discovers labs and designates first two as input labs (`inputLabIds` in `RoomMemory`).
- [x] **Lab manager** — `src/managers/labs.ts` `runLabs()` selects the best viable reaction (most available input materials) from `REACTIONS`, stores as `activeReaction` in `RoomMemory` (re-evaluated every 500 ticks). Runs `outputLab.runReaction(inputLab1, inputLab2)` on all non-input labs each tick. Hauler handles logistics: fills input labs from storage, collects output compounds from output labs, delivers to terminal or storage.
- [x] **Input lab flushing** — When `activeReaction` changes, `labs.ts` detects stale minerals in input labs and sets `labFlushing` flag. Hauler's `pickupLabFlush()` withdraws wrong minerals before loading new inputs. Flag auto-clears when labs are clean.
- [x] **Reaction chaining** — `src/utils/reactions.ts` provides `buildReactionChain`, `findNextChainStep`, `chainMissingInputs`, `REACTION_GOALS`. Labs now pick the highest viable step from a priority-ordered goal list (XGHO2→XLHO2→XGH2O→XZHO2 and tier-2 precursors), falling back to greedy if no goal chain is achievable.
- [ ] **Boost application (stretch)** — Designate combat/upgrader creeps to be boosted before departing spawn. Requires filling a lab with the target compound, routing the fresh creep to `lab.boostCreep()` before dispatching to its role. Useful for TOUGH-boosted defenders and WORK-boosted upgraders at RCL 8.

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

- [x] **Per-resource stockpile thresholds** — `src/utils/thresholds.ts` provides shared `MINERAL_STORAGE_FLOOR` (5k), `MINERAL_TERMINAL_CEILING` (50k), `ENERGY_TERMINAL_BUFFER` (50k), and `isTerminalSurplus()` helper. Hauler and terminal manager import from here (eliminated duplication).
- [x] **Market logging** — Terminal manager logs surplus minerals above `MINERAL_TERMINAL_CEILING` with best buy-order prices every 100 ticks. Read-only — no actual selling yet.
- [x] **Market selling** — `runTerminal` sells surplus above `MINERAL_TERMINAL_CEILING` to best buy order every 100 ticks.
- [x] **Market buying for lab inputs** — `buyForLabs()` in `terminal.ts` runs every 500 ticks. Queries `getChainBuyNeeds()` from labs manager (chain-aware), falls back to active reaction inputs. Buys cheapest sell order ≤ `MAX_BUY_PRICE` (0.5cr) in `BUY_BATCH_SIZE` (3k) batches. Gates on `MIN_BUY_ENERGY` (100k) terminal energy, skips own room's mineral type.
- [x] **Unit tests for RCL gating** — 16 tests across 12 describe blocks in `test/managers/construction.test.ts`. Each `place*` function tested for correct RCL gating (e.g. extensions at RCL 2+, towers at RCL 3+, storage at RCL 4+, links at RCL 5+, terminal/extractor/mineral at RCL 6+).

- [x] **Builder/repairer logistics integration** - Both roles now check `minerEconomy` and withdraw from source containers (closest, >100 energy) or storage before falling back to self-harvest. Shared `withdrawFromLogistics()` utility in `src/utils/sources.ts`. Bootstrap mode unchanged.
- [x] **Upgrader count scales with storage surplus** - `upgradersNeeded()` now adds bonus upgraders based on `room.storage` energy: >50k = +1, >200k = +2, >500k = +3. Additive to the existing capacity-based count.
- [x] **Roads to storage** - `placeRoads()` now includes `room.storage.pos` in its road targets when storage exists.
- [x] **Hauler storage withdrawal guard** - Haulers only withdraw from storage when spawn/extensions or towers (below 75%) need energy. Prevents draining storage to fill controller container.
- [x] **Storage withdrawal guard for builders/repairers/upgraders** — `withdrawFromLogistics()` and the upgrader's GATHER state now respect `STORAGE_ENERGY_FLOOR` (10k). Below this level, these roles fall back to self-harvesting, preserving reserves for spawns and hauler redistribution. Both fresh-selection and cached-target paths are guarded.
- [x] **Clustered extension placement** - Extensions now use a stamp pattern (`EXTENSION_STAMP` in construction.ts) instead of ring scanning. Compact diamond layout leaving road corridors on dx=0/dy=0 axes. Falls back to `findOpenPosition()` if all stamp cells are terrain-blocked.
- [x] **Rampart placement on critical structures** - `placeRamparts()` at RCL ≥ 3 places ramparts on spawns, towers, and storage. One per tick. Towers already repair ramparts (capped at 10k hits).
- [x] **Wall/rampart repair scaling** - `wallRepairMax(room)` replaces hardcoded 10k cap. Scales with storage energy (stored × 0.5) clamped to per-RCL caps: 3=10k, 4=50k, 5=300k, 6=1M, 7=5M, 8=50M. Cached per room per tick.
- [x] **CPU optimizations** - Construction runs every 5 ticks instead of every tick. Tower repair target cached per room (shared across towers). `status()` console command shows link info.
- [x] **Dynamic spawn counts for all roles** - All role counts in `spawner.ts` are now computed per-room per-tick via `*Needed(room)` functions: `buildersNeeded` scales 1–3 by `ceil(constructionSites / 3)` (paused to 0 when all sources are linked and storage < 10k), `repairersNeeded` scales 1–2 when >5 structures below 75% HP, `upgradersNeeded` scales 1–3 by room energy capacity, `haulersNeeded` 2–3 per source container, `minersNeeded` 1 per container without a miner, `defendersNeeded` by threat score. No hardcoded minimums except bootstrap harvesters (2) and emergency miner-economy harvester (1). Idle builders/repairers fall back to upgrading.
- [x] **Add multi-room support (remote mining)** - Scout role explores adjacent rooms and records source positions, remote planner evaluates/selects up to 2 best rooms (tolerates stale hostile sightings), miners reuse existing role with cross-room PathFinder pathing to stored source positions, remote miners self-build containers at remote sources, dedicated remoteHauler role for cross-room energy transport with full delivery chain (storage/spawns/towers/controller container), builder construction priority (extensions before storage). Expandable to claiming later.
- [x] ~~**Remote container repair**~~ — Removed. Remote haulers lack WORK parts so repair was never functional (caused a stall bug instead). Miners rebuild containers when they decay.
### Base traffic & layout improvements

Observed in W43N58: spawn area is heavily congested, haulers and remote haulers oscillate back-and-forth trying to path to similar locations. Root causes identified:

#### Roads inside the extension cluster

- [x] **Place roads along the extension stamp corridors** — Added `placeCorridorRoads()` which places roads on dx=0 (vertical) and dy=0 (horizontal) corridors through the extension diamond. Corridor width grows with RCL (`min(rcl - 1, 4)`). Skips tiles occupied by non-road/non-container/non-rampart structures. Called after `placeRoads()` in the construction pipeline.

#### Build order & link-first gating

- [x] **Reorder construction priority** — `runConstruction()` now places energy infrastructure first: source containers → controller container → storage → links → extensions → towers → roads. Terminal, extractor, mineral container, and labs are deferred to after energy infrastructure. This ensures source links get built before terminal/labs at RCL 6.
- [x] **Gate low-priority structures behind link completion** — `placeTerminal`, `placeExtractor`, `placeMineralContainer`, and `placeLabs` now skip if there are any unbuilt link construction sites. Prevents builders from working on terminal/labs while a source link is still under construction.

#### Unified layout planner (prevents extension/lab collisions)

- [x] **Pre-compute base layout at room claim** — `src/utils/layoutPlanner.ts` `computeLayout(room)` scores storage candidates by lab coverage (how many of 10 LAB_STAMP positions are buildable from that anchor), reserves lab+terminal+tower positions, filters EXTENSION_STAMP accordingly with overflow search. Result stored in `RoomMemory.layoutPlan`. `ensureRoomPlan()` triggers auto-compute; console command `replanLayout(roomName)` forces recompute. Each `place*` in `construction.ts` reads from the plan with fallback to old behavior. Logs blocked lab positions so user knows which extensions to demolish in existing rooms.

#### Hauler delivery target spreading

- [x] **Spread hauler spawn/extension delivery targets** — `deliverToSpawnOrExtension()` now finds all empty spawns/extensions, builds a set of targetIds claimed by other haulers/remoteHaulers in DELIVER state, sorts by range, and picks the closest unclaimed target. Falls back to closest overall if all are claimed. Eliminates the convergence where multiple haulers targeted the same nearest extension and oscillated.

#### Future spawn placement

- [ ] **Improve spawn site selection for new rooms** — When claiming new rooms, select a spawn position that has enough open terrain in all directions for the extension diamond + road corridors. Current `findOpenPosition` doesn't account for the full stamp footprint. Evaluate candidate positions by checking that the stamp's cross corridors (dx=0, dy=0) are walkable and that at least ~80% of stamp cells are buildable. Avoids the W43N58 situation where walls compress the layout into a congested corner.

### Economy rebalancing (Tier 2)

Energy starvation analysis (May 2026) surfaced structural issues that need a second pass once Tier 1 changes stabilise (monitor for ~5000 ticks after deploy):

- [ ] **Remote miner WORK cap for reserved sources** — `body.ts` caps remote miners at 5 WORK (10 e/t). A reserved source has 3000 capacity requiring 10 WORK for full saturation. Either raise cap to 10 gated on `scoutedReservation === 'Pharabus'`, or spawn 2 miners per remote source in reserved rooms.
- [ ] **Distance-aware remote hauler count** — `spawner.ts:285` uses flat `sourceCount * 2`. Replace with `Math.ceil(roundTripTicks * sourceRate / carryCapacity)` where `roundTripTicks` is estimated from `PathFinder.search` distance cached in room memory. For W43N59 (~50 tiles, 400 carry) this means 3–4 haulers, not 2.
- [ ] **Stop spawning idle builders/repairers** — `buildersNeeded` returns 1 even with zero construction sites (controller-upgrade fallback). `repairersNeeded` always returns at least 1. Return 0 when no sites exist and all structures are healthy — these roles become hidden upgraders that consume spawn slots without accounting for the extra controller drain.
- [ ] **Home hauler count: +1 per active remote room** — Remote energy arriving home needs distribution capacity. Current `haulersNeeded` counts only home sources; add `remoteRooms.length` to the total so there are enough haulers to handle the combined delivery load (spawn/ext fill + remote energy throughput).

### Multi-room expansion (claiming & reservation)

Builds on existing remote mining infrastructure (scout, remotePlanner, remote miners/haulers).

#### Phase 1 — Controller reservation (RCL 4+, GCL 1)

Reserving a remote room's controller doubles source capacity (3000/tick → 6000/tick) and halves container decay rate. Low cost, high return.

- [x] **Add `reserver` role** — `[CLAIM×2, MOVE×2]` body (1300 energy). Paths to the remote room's controller and calls `creep.reserveController()`. 2 CLAIM parts = +2 ticks/tick (net +1/tick). Spawned 1 per remote room with a controller. Scout records `scoutedHasController` for gating.
- [ ] **Remote room type field** — Add `type: 'remote' | 'reserved' | 'claimed'` to `RoomMemory` for remote rooms. `selectRemoteRooms()` sets type based on GCL availability and distance. Spawner uses type to decide which roles to queue (reserver only for `reserved`, full colony for `claimed`).
- [ ] **Spawner integration** — Queue 1 reserver per `reserved` remote room, after remote haulers in priority. Only spawn when room has a controller (some remote rooms are source keeper or highway rooms with no controller).
- [x] **Remote road building** — Place roads from home room spawn to remote source positions along the PathFinder route. Hauler throughput increases ~2x on roads (fatigue halved). Build incrementally (1 site/tick like local roads). Only for reserved rooms (worth the investment).

#### Phase 2 — Room claiming (GCL 2+)

Claiming a second room gives a full autonomous colony. Requires GCL 2 (earned by upgrading controllers). Much more complex than reservation.

- [ ] **Add `claimer` role** — `[CLAIM, MOVE×5]` body. Paths to target room's controller and calls `creep.claimController()`. One-shot role — once claimed, the creep can be recycled. Needs 5 MOVE for off-road travel at full speed.
- [ ] **Per-room creep counting** — `countCreepsByRole()` is currently global. Claimed rooms need their own spawn queues. Refactor to count per `homeRoom`. Each room runs `buildSpawnQueue()` independently.
- [ ] **Colony bootstrap sequence** — After claiming: (1) send a builder with energy to build the first spawn, (2) once spawn is up, the new room runs the normal bootstrap economy, (3) home room may need to send energy via terminal to accelerate early RCL.
- [ ] **Target room selection** — Evaluate rooms by: source count (2 preferred), distance from home (linear range ≤ 3), mineral type (complement home room), terrain openness (room for base layout), hostile proximity. Store evaluation in Memory for manual override.
- [ ] **Inter-room energy transfer** — Terminal `send()` energy from established rooms to new colonies during bootstrap. Add to `terminal.ts` manager: detect claimed rooms below RCL 4 (no storage yet) and send energy if home has surplus.
- [ ] **Remote defense policy** — Decide per-room: flee (pull creeps home when hostiles appear, for undefended remotes), defend (spawn defenders, for reserved/claimed rooms with investment), or abandon (drop the room from remoteRooms if hostiles are persistent). Add `defensePolicy` to remote room memory.

### Advanced defense

Current defense: tower focus-fire, safe mode, melee defenders. Sufficient for NPC invaders but not player attacks.

#### Towers & walls

- [ ] **Rampart maze / bunker layout** — Design a base layout where all critical structures are behind ramparts, with a maze entrance that forces attackers to walk under multiple towers. Requires rethinking the extension stamp and structure placement to fit within a walled perimeter.
- [ ] **Active wall repair under siege** — During an attack, prioritize repairing the rampart being targeted over other repair work. Towers already focus-fire; add logic to detect which rampart is taking damage and have multiple towers repair it simultaneously when not shooting.

#### Defender improvements

- [ ] **Ranged defender role** — `[RANGED_ATTACK, MOVE]` body. Kites hostiles from range 3, retreats behind ramparts when damaged. More effective than melee against boosted attackers who can one-shot melee defenders.
- [ ] **Healer role** — `[HEAL, MOVE]` body. Pairs with defenders to sustain them during extended fights. Stays at range 1 behind the attacker. Useful once we face enemies with HEAL parts.
- [ ] **Boosted defenders** — At RCL 7+ with lab compounds available, boost defenders with TOUGH (damage reduction) and ATTACK/RANGED_ATTACK compounds before dispatching. Requires boost application infrastructure (see Stage 3 labs todo).
- [ ] **Defender duo/quad formations** — Coordinated movement of 2-4 creeps as a unit (attacker+healer, or ranged+healer pairs). Requires a formation manager that moves all creeps in lockstep. End-game PvP capability.

#### Intel & strategic

- [ ] **Observer placement and scanning** — Place observer at RCL 8. Scan a queue of rooms each tick (`observer.observeRoom()`). Use for: scouting highway rooms for deposits/power banks, monitoring hostile neighbors, checking remote room status without sending creeps. Add `src/managers/observer.ts` with a scan queue in Memory.
- [ ] **Threat memory and neighbor tracking** — Record hostile player names, attack patterns, and room ownership in Memory. Use to: avoid placing remotes near aggressive players, preemptively spawn defenders when a known attacker's creeps are spotted in adjacent rooms, prioritize safe mode charges.

### Offensive capabilities

All offensive operations are end-game (RCL 7-8) and require significant economy to sustain.

- [ ] **Nuker placement and targeting** — Place nuker at RCL 8 near storage (needs 300k energy + 5k G to load). Add `src/managers/nuker.ts`: auto-load when resources available, select targets via console command (`nuke(roomName, x, y)`). 50k tick cooldown (~14 hours). Primary use: break walls/ramparts in hostile rooms before sending an attack squad.
- [ ] **Scout/harass role** — Cheap `[MOVE]` creep sent to hostile rooms to gather intel: layout, tower positions, wall HP, creep composition. Store in Memory for attack planning. Can also be `[MOVE, MOVE, WORK]` to dismantle undefended structures.
- [ ] **Dismantler role** — `[WORK×N, MOVE×N]` body. Targets hostile walls/ramparts with `creep.dismantle()` (50 HP per WORK per tick, ignores rampart protection). Used after nukes soften walls. Needs healer support to survive tower fire.
- [ ] **Attack squad manager** — Coordinates multi-creep attacks on hostile rooms. Phases: (1) scout target, (2) nuke walls, (3) send dismantler+healer pairs to breach, (4) send attackers to destroy spawn/storage. Requires formation movement, heal coordination, and retreat logic. Complex — defer until other systems are mature.
- [ ] **Drain attack** — Send a single boosted `[TOUGH×N, MOVE×N]` creep to sit at a hostile room's edge, tanking tower damage while healing. Towers drain energy faster than the room can refill. Cheap, effective against rooms with limited tower count or poor energy income. Retreat and re-send when HP drops.
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
