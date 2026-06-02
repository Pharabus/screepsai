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
   7b. `runLabs` — reaction selection (every 500 ticks), runs reactions when inputs loaded. `labFlushing` flag triggers hauler to clear stale minerals before loading new inputs. Boost lab (`boostLabId`) is skipped by the reaction loop. **Goal rotation**: `selectReaction` walks `REACTION_GOALS` and skips any goal whose stock ≥ its `GOAL_CAPS` entry (hysteresis: resumes below cap×0.5), so production rotates GH2O → defensive precursors (GHO2/KHO2/LHO2) once GH2O is satisfied instead of welding to GH2O forever.
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

### Mission registry (`src/utils/missions.ts`)

Grouped goal-tracking lives in `Memory.missions`, a strictly-typed `MissionRegistry` (one sub-map per `MissionType`). Every record extends `MissionBase` (`type`, `id`, `status`, `createdAt`, `lastSynced`). Generic helpers — `getMissionRegistry()`, `getMissionsOfType<T>(type)`, `garbageCollectMissions()` (registry-wide) — sit under the type-specific API. **Invariant from the shelved hauler pool:** a mission governs spawn **quotas, lifecycle, and strategic gating** only — it counts creeps (e.g. `RemoteMiningMission.haulerIds.length`) and never micro-dispatches a committed creep's per-tick task. Types: `remoteMining` (spawner-consumed; miner ownership stays canonical in `RoomMemory.sources[].minerName`) `colony` (the claim/expansion lifecycle `claiming→bootstrapping→active`, owned by `colonyPlanner.ts`; legacy `Memory.colonies` folded in at Step 2 via `migrateColoniesToMissions()`), and `defense` (Step 3, formalize-only) — one record per owned room's combat engagement, owned by `runDefense` (`defense.ts`): `active` on threat, `retiring` when it clears so the generic GC reclaims it. The DefenseMission mirrors the `combatActive` flag (retained for safe-mode/tower-drain logging — a future cleanup could merge them); its `composition` snapshot is stamped by the spawner (disjoint field, avoids a defense↔spawner import cycle). Adding a type = one field on `MissionRegistry` + a `getMissionRegistry()` sub-map guard. **Deferred:** cross-room defense dispatch and an `SKMission` type.

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
- **`ensureBoosted(creep)`** (`src/utils/boost.ts`) — pre-role boost gate. Returns `false` while routing to a lab for `boostCreep`. **Fails open** (clears `boosts`, returns `true`) when no lab is found — a creep must never stall permanently waiting for a boost. The reserved `boostLabId` is used only when its `boostCompound` matches the requested entry (else falls through to searching any stocked lab — prevents a defender wanting KHO2 stalling at the GH2O lab). GH2O upgrader boost is complete and active; defenders (rangedDefender→KHO2, healer→LHO2) boost opportunistically off the rotating lab stock.
- **`getColonyScore(room)`** (`src/utils/colonyPlanner.ts`) — heap-cached score: `rclFactor × incomeRate × storageFactor`. Higher = worth investing in first. Used by upgrader count gates, colony energy sending, and visuals.
- **Hauler pickup priority** (`src/roles/hauler.ts`): committed target → urgent responder → large dropped energy → lab flush/input/output → storage link → boost-lab service → dropped energy/minerals → ruins/tombstones → full source containers → **foreign-store drain** → mineral container → partial source containers → factory batteries → terminal minerals. The **foreign-store drain** (`pickupForeignStore`, reclaimed room's previous-owner storage via `lootTargetId`) ranks **low on purpose**: a foreign hoard is a *non-decaying reserve*, so it's drained only after decay-sensitive and fresh-income pickups (floor drops, full source containers). Placing it high starved the local economy — source containers overflowed to cap and miner output decayed on the floor while haulers drained a bank that loses nothing by waiting (observed live in W42N59). See `hauler.ts` for the full chain and delivery logic (minerals to boost lab / lab input / storage / terminal; drop as last resort on young colonies). **SHELVED: `Memory.haulerPool`** must stay off — pre-assignment via `src/managers/haulerPool.ts` conflicts with task-commitment (committed haulers ignore the assignment) and gave worse convergence in live testing. See `haulerPool.ts` header and `todo.md` Phase 6.

### Body scaling

`buildBody(pattern, energy, maxRepeats?)` in `src/utils/body.ts` scales with `energyCapacityAvailable` — do not hardcode bodies. Specialised builders: `buildMinerBody`, `buildUpgraderBody`, `buildRemoteMinerBody`. Non-production roles capped via `maxRepeats` to control spawning cost.

### Defense

- **Threat scoring** (`src/utils/threat.ts`): HEAL > CLAIM > RANGED_ATTACK > ATTACK > WORK (dead parts ignored). `pickPriorityTarget` weights threat + range-adjusted tower effectiveness — prevents wasting fire on border creeps while closer hostiles roam.
- **Focus-fire is deliberate policy** (`managers/towers.ts`) — closest-target fire lets healers keep attackers alive indefinitely.
- **Safe mode** triggers only when a `threatScore > 0` hostile is within range 5 of a spawn/storage/controller — scouts don't burn a charge.
- **`defendersNeeded`** is tower-aware: returns 0 if energised towers can solo the threat and the enemy can't out-heal tower DPS. Towers fire regardless; this removes redundant spawn cost only.
- **`defenderComposition`** (`src/managers/spawner.ts`) — returns `{ melee, ranged, healer }` counts by threat band, capped at 4 total. `defenderBoostsWanted(room)` (RCL 7+ and an aggressive *player* hostile present — NPCs excluded) attaches T2 boosts to ranged/healer requests; melee stays unboosted (no TOUGH parts in its body). Fail-open, so unstocked rooms spawn unboosted.
- **`src/utils/neighbors.ts`** — records hostile player intel in segment 5. Players classified `aggressive` cause remote planner to reject their observed rooms for 20k ticks.
- **Hunter role** (`src/roles/hunter.ts`) — clears NPC Invaders from remote/transit rooms. Targets `'Invader'` owner only; never engages players. TRAVEL state waits for `isInRoomInterior` before transitioning to HUNT — prevents work starting on a border tile the engine auto-evicts. Priority 1, one per infested room.
- **Remote threat flee** (`src/utils/remoteThreat.ts`) — `handleRemoteThreat` runs first in miner/reserver/remoteBuilder/empty-remoteHauler roles: flee home and skip the state machine while the target remote room had a threat-scoring hostile within a cooldown. **Cooldown is owner-scoped**: NPC-only sightings (`'Invader'`/`'Source Keeper'`) use `NPC_HOSTILE_COOLDOWN` (50, comfortably above a hunter's ~20–30 tick kill) so a fresh miner doesn't time out waiting on an Invader the hunter already cleared; any player aggressor uses `HOSTILE_COOLDOWN` (300). The triggering sighting's classification is stored in `RoomMemory.hostileLastWasPlayer`; a missing flag (legacy memory) is treated as player (long cooldown) — fail-safe. SK rooms exempt Source Keepers (keeperKiller handles them); haulers with cargo finish their delivery.
- **Perimeter defense** (`src/utils/perimeterPlanner.ts`) — `computePerimeter` flood-fills inward from exits, stops at a Chebyshev `CORE_RADIUS` box around the spawn anchor; perimeter = exterior tiles bordering the interior. Walls on non-gate tiles, ramparts on gate tiles. Gate targets: sources outside core, distant controller, one per remote-room exit direction. `getPlannedReserved()` includes wall tiles so road pathfinding routes through gates. Stored in `RoomMemory.perimeterPlan`, invalidated by `PERIMETER_PLAN_VERSION` bump or remote-room change. `replanPerimeter(room)` forces a recompute; `construction.ts` consumes `perimeterPlan`. A terrain-aware min-cut variant (and a RoomVisual overlay) were prototyped and **removed** (v1.0.219–220) — live validation showed the min-cut cost more wall than the radius ring for our room geometry; see git history (v1.0.216–218) before re-attempting against fresh data.
- **Combat log** (`src/utils/combatLog.ts`) — ring buffer in `Memory.combatLog`. Console: `combatLog()`.

### Profiling & visuals (opt-in)

- `Memory.profiling = true` → `profile(name, fn)` records CPU EMA in `Memory.stats`.
- `Memory.visuals = true` → per-room headers, storage level, controller progress, idle creep indicators.
- `Memory.profileOverlay = true` (requires visuals) → sorted CPU table overlay on first owned room.

Wrap new managers/hot paths in `profile('label', fn)`. Console exports: `stats()`, `resetStats()`, `status()`, `replanLayout(roomName)`, `replanPerimeter(roomName)`, `combatLog()`, `neighbors()`, `suggestSpawn(roomName)`, `colonies()`, `claim(roomName)`, `evaluateClaim(roomName)`, `claimCandidates()`. Add new commands as `export const` in `main.ts` and register on `global`.

### Creep state machine

All roles use `src/utils/stateMachine.ts`. Each `StateHandler.run(creep)` returns a state name to transition or `undefined` to stay. State persisted in `creep.memory.state`. Falls back to default on rename (safe deploy). `onEnter()` called on transition.

### Movement & traffic

- **Always use `moveTo()`** from `src/utils/movement.ts` — never `creep.moveTo()` or `creep.move()` directly.
- CostMatrix (`src/utils/trafficManager.ts`): roads=1, moving creeps=**0** (not soft-avoid — cost-50 inflated corridors near idle hauler clusters, pushing PathFinder onto longer detours), stationary/hostile/impassable=255. Stuck-detection repath still uses cost-50 so recovery paths route around active blockers.
- **Obstacle-type construction sites = 255** (`applyConstructionSiteOverlay`). The Screeps engine refuses a move onto your *own* construction site of an obstacle structure (extension/link/tower/lab/terminal/storage/spawn/extractor/observer/powerSpawn/nuker/factory/constructedWall); road/container/rampart sites stay walkable. These sites aren't `FIND_STRUCTURES`, so they're absent from the base matrix — applied fresh in the per-tick overlay (not the 20-tick base cache) so completed/cancelled sites update immediately. **Without this, every RCL upgrade froze creeps**: a batch of new sites lands on live corridors, PathFinder routes through them at terrain cost, the engine cancels the move (observed: a miner stuck beside a fresh link site in W44N57). The earlier version marked only extension sites at cost 10 — passable-but-expensive — which was wrong: the engine hard-blocks them, so 10 still routed creeps into a wall.
- **Active blocker pushing** (`pushBlocker`): nudges a lower-priority creep off the next tile. Best-effort, one push per tick per creep.
- **Stuck detection**: repath at 2 ticks stuck; force-repath with cache invalidation at 3 ticks, retry every 3.
- Room callback skips unseen rooms owned by other players — avoids pathing into enemy tower range.
- Pass `range: 0` when the role must stand on a specific tile (default range is 1).
- **`isInRoomInterior(creep)`** — true when ≥3 tiles from every border edge. Use in TRAVEL states: border-tile creeps can be auto-evicted by the engine.

### Remote mining

1. `scout` (1 MOVE) records source count, ownership, hostile presence, and source positions. Spawned only when below the storage-gated remote cap — no permanent scout.
2. `selectRemoteRooms()` (`src/utils/remotePlanner.ts`) — rejects owned/player-reserved/hostile rooms; scores candidates **distance-aware**: `sourceCount × SOURCE_SCORE_WEIGHT (100) − oneWayPathTiles`, so an extra source dominates (a 2-source room always beats a 1-source room) but among equal source counts the **closer** room wins, and any candidate beyond `REMOTE_MAX_PATH_TILES` (120 one-way) is hard-rejected. Path length comes from a cached PathFinder pass (`ensureRemotePathLength`, recomputed >5000 ticks stale; also feeds `remoteHaulersWanted`); when there's no spawn / the room is dark it falls back to a source-only score so selection never stalls. Selected up to a **myStorage-gated** cap (`remoteRoomCap`, hysteresis near 100k). **Gated on `myStorage(homeRoom)`, not `room.storage`** — a reclaimed room's owner-agnostic foreign storage otherwise makes a fresh RCL2 colony spin up unaffordable remotes; with no own storage the selection is cleared to `[]`, freeing those remotes for **inter-colony de-confliction** (`claimedByCloserColony`): a remote is left to whichever storage-bearing sibling colony has the **shortest cached one-way path** to it (ties broken by room name), decided on distance alone — **not** on who currently claims it, which was order-dependent and let two colonies grab the same room in one selection pass (live: W43N58 + W44N57 both took W44N58). So two colonies never double-mine one room. The scouted-hostile rejection is **NPC-aware**: a sighting flagged NPC-only (`scoutedHostileIsPlayer === false`) blocks selection for just `NPC_SCOUT_REJECT_TICKS` (300 — hunters clear invaders fast), while a player sighting (or missing flag → fail-safe player) blocks for `PLAYER_SCOUT_REJECT_TICKS` (1500). Known-*aggressive* players are independently hard-blocked 20k ticks by the `aggressiveInRoom`/`hostilesSeen` check. Mirrors the live-validated NPC-vs-player split in `remoteThreat.ts`.
3. `ensureRemoteRoomPlan()` — scans visible remote sources; bootstraps from `scoutedSourceData` when dark.
4. Remote miners reuse the `miner` role with `targetRoom` set. They have 1 CARRY to build/repair their container. Pre-spawned `REMOTE_MINER_PRESPAWN_TICKS` before predecessor TTL to avoid coverage gaps.
5. `remoteHauler` picks up energy from the remote room, delivers home. Delivers `RESOURCE_ENERGY` **only** — picking up non-energy minerals would trap them in the hauler permanently. **Not spawned until the remote source container exists** (`remoteMem.sources[].containerId`, set by the miner/`ensureRemoteRoomPlan`): before that the 1-CARRY miner is still building the container and produces little to haul, so pre-spawned haulers would just round-trip idle.
6. `reserver` (`[CLAIM×2, MOVE×2]`) — 1 per remote room with a controller; net +1 reservation/tick doubles source capacity.
7. `remoteBuilder` — builds/repairs remote roads. Temporary; stops spawning when roads are built and healthy.

`placeRemoteRoads` is **tunnel-aware**: its PathFinder pass stamps natural wall tiles at `TUNNEL_WALL_COST` (15× plain) via `applyTunnelWalls`, so a road routes through a wall only when it shortcuts a detour >~15 tiles longer. This overlay is local to road planning — it never touches the creep-movement CostMatrix (creeps can't walk unbuilt walls). Built roads (cost 1) always beat tunnels, so completed paths are never re-dug.

`CreepMemory.homeRoom` = owner room. `CreepMemory.targetRoom` = operating room. Local miners have neither.

**Claiming** (`src/utils/colonyPlanner.ts`): `scoreClaimTarget` filters/scores a candidate (sources, distance, hostility, +5 for a mineral none of our rooms already mine); `findClaimCandidates()` ranks all scouted rooms, picking each one's nearest owned room as prospective home. Operator commits via `claim(roomName)`; inspect readiness with `claimCandidates()`. Lifecycle `claiming → bootstrapping → active` in `updateColonyStates`.

### Reclaiming a captured room

A room claimed from a previous owner is littered with their leftover structures. These are **owned by the old player and unusable by us**, and obstruct movement *and* our own construction. `cleanupClaimedRoom(room)` (`construction.ts`, called from `runConstruction` every 5 ticks for each owned room) handles this:

- **Destroys** foreign obstacle structures (`FOREIGN_OBSTACLE_TYPES`: spawn, extension, tower, link, lab, extractor, terminal, factory, observer, powerSpawn, nuker, storage) — via `.destroy()`, which is free/instant and legal because we own the controller. **Critically, it destroys them even when they hold a little energy**: a foreign spawn/extension counts against *our* RCL structure-count limit, so a 300-energy leftover spawn returns `ERR_RCL_NOT_ENOUGH` on our own placement and hard-stalls the colony (observed live in W42N59 — `placeColonySpawn` silently bailed every tick, builders dumped energy into the controller instead). Only `LOOTABLE_TYPES` (storage/terminal) **still holding resources** (`storeUsed > 0`) are spared for the drain path.
- **Keeps** roads & containers (ownership-neutral, reusable) and constructedWalls that are in the `perimeterPlan`; destroys unowned walls only when they sit on a planned layout tile.
- **Removes all foreign construction sites** (`FIND_HOSTILE_CONSTRUCTION_SITES` → `.remove()`, legal in a room we own). We can't build another player's site and they block our own placement; an unfinished foreign site has no reuse value (unlike a built road).
- **`.destroy()` voids a structure's store, but `withdraw()` works directly on a foreign storage/terminal in a room we own** (live-validated W42N59, 2026-06-02: a normal hauler moved energy out, no WORK part needed). So a real hoard (e.g. W42N59's 607k-energy storage) is left standing (recorded in `RoomMemory.lootTargetId`) and **drained losslessly by existing haulers** via `pickupForeignStore` (`hauler.ts`) — high in the pickup chain, alongside `pickupLargeDrop`. Energy drains at any RCL straight into the colony (spawn/extensions/controller container); a non-energy mineral is only pulled once we have an **own** storage/terminal to receive it (else it's left in place — never trap a mineral in a hauler). Once the husk is **truly empty** (`storeUsed === 0`), the next cleanup sweep `.destroy()`s it, freeing the single storage slot → `placeStorage` builds ours on the next tick. **Drain-to-empty, then swap — lossless, no early-destroy lever, no dedicated creep.** (An earlier dismantle-based `looter` role was built on the *untested* assumption that `withdraw()` fails on a foreign store; that was disproven live and the role removed.)
- **Ownership guard:** `room.storage`/`room.terminal` are **owner-agnostic** — in a reclaimed room they return the *previous owner's* structure. Use `myStorage(room)` / `myTerminal(room)` (`src/utils/ownership.ts`) at every ownership-sensitive site (deposits, placement gates, link anchoring, layout `storagePos`) so we never deposit our income back into the foreign store or skip placing ours. The drain path (`pickupForeignStore`) deliberately reads the foreign store directly via `lootTargetId`.

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
