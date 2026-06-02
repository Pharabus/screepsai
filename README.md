# Screeps AI

A TypeScript Screeps AI focused on automated room management from RCL 1 through RCL 7+: bootstrapping a creep workforce, transitioning to a miner/hauler/link economy, expanding the base (extensions, towers, roads, storage, links, terminal, extractor, factory), defending with towers and defenders, mining minerals, producing commodities, and remote mining adjacent rooms including Source Keeper rooms.

## Features

- **TypeScript** with strict mode, bundled by Rollup into a single `dist/main.js`.
- **ErrorMapper** to translate runtime errors back to TypeScript source lines.
- **Priority-based spawner** that maintains minimum creep counts per role and scales bodies to the room's `energyCapacityAvailable`.
- **Automated construction manager** that places extensions (stamp layout), towers, containers, storage, links, terminal, extractor, roads, and ramparts based on RCL.
- **Link network** (RCL 5+) — source links near miners transfer energy instantly to a storage link; hauler count auto-reduces for linked sources, +1 hauler when mineral/lab infrastructure exists.
- **Defense stack** — threat-scored focus-fire for towers, automatic safe-mode activation on base-perimeter breach, reactive `defender`/`rangedDefender`/`healer` creeps for player threats, and `hunter` creeps dispatched to clear NPC Invaders from remote and transit rooms.
- **Load-balanced harvesting** that spreads creeps across available sources.
- **Memory optimisations** — lazy `RawMemory` segment wrapper, per-tick cache, and one-shot Memory shape init to keep the per-tick JSON parse cheap as persistent data grows.
- **CPU profiler** with exponential-moving-average samples per manager and per role, exposed via console globals `stats()` / `resetStats()`.
- **Remote mining** — Scouts explore adjacent rooms; remote planner picks the best room(s), auto-scaling the cap with home storage (1 remote below 100k, 2 above) with hysteresis (drops back to 1 only below 70k to prevent churn); rejects rooms with recent aggressive-neighbor sightings; remote miners and haulers harvest energy from unowned rooms and deliver it home.
- **Lab reactions** (RCL 6+) — Stamp-based lab placement (3/6/10 labs at RCL 6/7/8), automatic reaction selection from available minerals, hauler-managed input/output logistics.
- **Terminal policy** (RCL 6+) — Haulers fill storage with minerals up to a 5k floor before overflowing to terminal (keeps labs supplied without round-tripping through the market); terminal manager sells terminal minerals above a 10k sell floor to the best buy order every 100 ticks, reserving 5k energy for transaction fees. The sell floor sits below the 20k combined hold/throttle cap so a sellable band always exists (sharing one 20k value previously deadlocked sales — the terminal could never cross its own sell line). Also ships 10k energy every 100 ticks to the highest-priority colony whose terminal is online but storage is below 30k — receiver is ranked by colony priority score (highest first), then storage urgency, then distance; a 300-tick hysteresis prevents re-sending on the same route before the shipment is absorbed.
- **Factory** (RCL 7+) — Placed adjacent to storage; produces `RESOURCE_BATTERY` (50 energy → 1 battery) at level 0 when home storage exceeds 50k. Haulers deliver energy and collect batteries for the terminal. `LAYOUT_PLAN_VERSION` versioning ensures cached layout plans auto-recompute on planner changes.
- **Source Keeper room opt-in** (RCL 7+, `energyCapacityAvailable >= 5300`) — SK rooms (3 sources × 3000 capacity) can be added to `remoteRooms` once a keeperKiller is assigned and alive. `evaluateRemoteRoom` scores them at `sourceCount * 3`. Remote miners use 10-WORK bodies; hauler formula uses `isHighCapacity = isReserved || isKeeperRoom` for correct count scaling. Source Keeper NPCs are excluded from the flee scan — only player hostiles trigger retreat.
- **CPU bucket throttling** — `shouldRun({ priority, interval })` gates each manager: CRITICAL always runs; HIGH skips below 2k bucket; NORMAL skips below 5k; LOW skips below 8k. Construction and visuals also have tick-interval gating.
- **Soft traffic manager** — CostMatrix-based pathing avoids creep clusters (cost 15) and hard-blocks stationary miners (cost 255). Each creep paths and moves independently; the Screeps engine handles 2-way swaps natively. Stuck detection fallback after 3 ticks. Cross-room pathing uses `maxRooms: 2`.
- **Creep state machine** — all roles use a lightweight FSM (`StateMachineDefinition`) with state persisted in `creep.memory.state` for in-game debugging.
- **Visual debugging overlay** (opt-in, `Memory.visuals`) drawing per-room RCL / energy / colony priority score / storage level / controller progress / creep counts / source load / idle creep indicators / path visualizations via `RoomVisual`. A sub-toggle `Memory.profileOverlay` adds a sorted CPU stats table (top 12 managers by average cost, colour-coded) on the first owned room.

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
    construction.ts       # Places extensions, towers, containers, storage, links, terminal, factory, extractor, labs, roads, ramparts by RCL
    defense.ts            # Threat tracking, safe-mode activation, defender demand
    links.ts              # Link network: source links → storage/controller link transfers
    labs.ts               # Lab reaction selection and execution (RCL 6+)
    terminal.ts           # Sells surplus minerals; buys lab inputs; inter-room energy transfer
    factory.ts            # Battery production at level 0 (RCL 7+)
    visuals.ts            # Opt-in RoomVisual overlays (gated by Memory.visuals)
  roles/
    Role.ts               # Role interface (run(creep))
    index.ts              # Role registry keyed by CreepRoleName
    harvester.ts          # Bootstrap economy energy delivery
    upgrader.ts           # Controller upgrader (container/storage or self-harvest)
    builder.ts            # Build sites, withdraw from logistics in miner economy
    repairer.ts           # Repair structures, withdraw from logistics in miner economy
    defender.ts
    miner.ts              # Static source miner (heavy WORK+CARRY, link-aware, supports remote rooms)
    hauler.ts             # Energy + mineral + lab logistics (link/container → structures/storage/terminal/labs)
    mineralMiner.ts       # Mineral extractor miner (RCL 6+)
    scout.ts              # Explores adjacent rooms for remote mining candidates
    remoteHauler.ts       # Cross-room energy transport (remote room → home room)
    hunter.ts             # NPC Invader dispatch (remote and transit rooms)
  utils/
    body.ts               # buildBody(pattern, energy, maxRepeats)
    sources.ts            # gatherEnergy / withdrawFromLogistics / harvestFromBestSource
    delivery.ts           # Shared delivery helpers (spawn/extension, controller container)
    colonyPlanner.ts      # Colony priority scoring (getColonyScore) + lifecycle tracking (coloniesForHome)
    roomPlanner.ts        # Room plan caching (sources, containers, links, minerals, miner assignments, remote rooms)
    remotePlanner.ts      # Evaluates and selects adjacent rooms for remote mining (including SK rooms)
    remoteThreat.ts       # Flee/ignore logic for remote creeps (Source Keeper exemption for keeper rooms)
    threat.ts             # threatScore / pickPriorityTarget for hostile creeps
    stateMachine.ts       # Lightweight FSM engine (StateMachineDefinition, runStateMachine)
    movement.ts           # moveTo wrapper — stuck detection + PathFinder pathing; isInRoomInterior border-safe arrival check
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
   7b. `runLabs()` — Selects a reaction from available minerals (re-evaluated every 500 ticks), runs `outputLab.runReaction(inputLab1, inputLab2)` on all output labs each tick when input labs are loaded. Stores the active reaction in `RoomMemory.activeReaction`. A lab reserved for boosting (`RoomMemory.boostLabId`) is skipped by the reaction loop.
   7c. `runTerminal()` — Runs every 100 ticks. Sells terminal minerals above the 10k sell floor (below the 20k hold/throttle cap so a sellable band exists); buys lab inputs when chain needs them; sends inter-room energy to colonies with low storage.
   7d. `runFactory()` — Runs at THROTTLE_NORMAL (skipped below 5k bucket). RCL 7+ only. Produces batteries from surplus energy at level 0.
8. `runConstruction()` — Runs every 5 ticks. Places extensions, towers, containers, storage, terminal, extractor, links, labs, roads, ramparts — gated by RCL.
9. `runVisuals()` — Opt-in `RoomVisual` overlay (no-op unless `Memory.visuals` is true). Includes idle creep indicators.
10. `flushSegments()` — Serialises any mutated `RawMemory.segments` entries and registers requested segments for the next tick.

Each of steps 3–9 is wrapped in `profile(...)` so per-manager CPU cost surfaces in `stats()`. Per-creep dispatch in step 6 is labelled `role.<roleName>` for per-role CPU tracking.

## Roles

All roles implement the `Role` interface (`run(creep: Creep): void`) in `src/roles/Role.ts` and use the FSM engine in `src/utils/stateMachine.ts`. Each role defines a `StateMachineDefinition` with named states; state is persisted in `creep.memory.state` so you can inspect what any creep is doing in-game. Builder and repairer roles refill via the shared `gatherEnergy()` helper (`src/utils/sources.ts`), which withdraws from logistics infrastructure (containers/storage) in miner economy or self-harvests from the best source in bootstrap economy. Delivery logic shared between hauler and remoteHauler is extracted into `src/utils/delivery.ts` — haulers opportunistically fill adjacent spawns/extensions, cache movement targets across ticks, and spread across unclaimed targets to avoid convergence oscillation.

| Role           | Minimum                                                   | Body pattern                                                                                                                             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miner`        | 1/source (miner economy)                                  | Local: `buildMinerBody` (max 6 WORK + CARRY + MOVE); Remote: `buildRemoteMinerBody` (WORK+MOVE pairs + CARRY, cap 5 WORK)                | Sits on a container adjacent to its assigned source and harvests indefinitely. Transfers energy to adjacent link if available (requires CARRY). Remote miners path directly to stored source positions via cross-room PathFinder, build their own container, then repair it when damaged using their CARRY buffer.                                                                                                                                                                                                                                                                                       |
| `hauler`       | 2-3/source unlinked, 2 linked (+1 with mineral/lab infra) | `[CARRY×2, MOVE×2]`                                                                                                                      | Task commitment: once a hauler picks a target it finishes the trip before re-evaluating. Only the nearest hauler to storage responds to urgent spawn/extension/tower energy needs (can preempt, but not within range 3 of a committed target). Pickup priority: large dropped energy (≥1000, preempts link drain) → lab flush/input/output → storage link (≥200) → boost-lab service (tops up the reserved boost lab with GH2O + energy; active at RCL 7+ when GH2O stock ≥ 1500 and storage energy is above floor) → dropped energy (≥50) → dropped minerals (≥50, skipped when room lacks storage/terminal) → ruins/tombstones (energy only; non-energy skipped when no storage/terminal) → source-container leg (see below) → factory batteries → terminal minerals. **Source-container leg**: by default each hauler picks the fullest source container (commitment-based). A `Memory.haulerPool` dispatcher (`src/managers/haulerPool.ts`) exists but is **shelved/dormant — keep it off**: live validation showed it conflicts with the task-commitment model (committed haulers ignore the assignment, unassigned extras re-converge) and degraded distribution. Flag off (the default) runs the legacy fullest-first selection unchanged. Non-energy minerals drop via `creep.drop()` as last resort if no storage or terminal exists (prevents permanent DELIVER deadlock in young colonies). Delivery skips controller container when storage is below floor; controller container delivery requires ≥200 free capacity to prevent trivial top-offs. |
| `harvester`    | 2 (bootstrap) / 0–1 (miner economy)                       | `[WORK, CARRY, MOVE]`                                                                                                                    | Self-harvests then delivers energy to spawn/extension/tower. In miner economy retires to 0 once every source has an assigned miner; spawns 1 emergency bootstrap creep only when a source lacks a miner.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `upgrader`     | 2 (bootstrap) / 0–4 (miner economy)                       | Bootstrap: `[WORK, CARRY, MOVE]`; Miner: `[WORK×2, CARRY, MOVE]` ×4 (young colony: capped at 600 below 5k, 1100 below 15k, full above 15k; mature: 600 below 5k, 1100 below 50k, full above 50k) | In miner economy: withdraws from controller container or storage, camps at controller (range 3). At low storage (<5k) a room below RCL 8 keeps 1 upgrader so the controller keeps progressing; a built-out RCL 8 room returns 0 to let storage refill. **Young colony (RCL < 6)**: aggressive ramp with 3 safety gates — income gate (score ≥ 20, else return 1), builder guard (no sites or storage ≥ 20k), then 2/3/4 upgraders at 15k/40k storage. **Mature (RCL 6+)**: conservative 1/2/3/4 at 100k/200k/500k — storage builds surplus before adding drain. Body cap shrinks under storage scarcity to prevent draining faster than miners refill. At RCL 7+, when GH2O ≥ 1500 and storage energy is above floor, newly spawned upgraders are boosted with GH2O (+50% WORK output) via `ensureBoosted()` before entering the state machine. |
| `builder`      | 0–3 (by site count)                                       | Bootstrap: `[WORK, CARRY, MOVE]`; Miner: `[WORK, CARRY, MOVE×2]` ×4                                                                      | Builds `FIND_MY_CONSTRUCTION_SITES` prioritized by type (spawn > extensions > tower > containers > storage > roads > ramparts), falls back to upgrading when idle. Returns 0 when there are no active construction sites. (Reclaimed-room cleanup of previous-owner structures is handled by `cleanupClaimedRoom` in `construction.ts`, not the builder.) Gathers energy via shared `gatherEnergy()` (logistics withdrawal in miner economy, self-harvest in bootstrap).                                                                   |
| `repairer`     | 1–2 (by damage)                                           | `[WORK, CARRY, MOVE]`                                                                                                                    | Repairs structures below 75% HP (excluding walls), falls back to upgrading. Gathers energy via shared `gatherEnergy()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `defender`     | dynamic                                                   | `[ATTACK, MOVE]`                                                                                                                         | Chases the highest-threat hostile. Marks idle and rallies near storage/spawn when no hostiles. Only produced during active threats.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mineralMiner` | 0–1 (RCL 6+)                                              | `[WORK×2, MOVE]` ×5                                                                                                                      | Stands on mineral container and harvests when mineral is not depleted. Spawned only when extractor + container exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scout`        | 0–1 (miner economy)                                       | `[MOVE]`                                                                                                                                 | Explores adjacent rooms, records source count/ownership/hostiles/positions. Re-scouts every 5000 ticks. Only spawned when there is an unscouted or stale room AND the colony is below its storage-gated remote cap (stops scouting once at cap).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `remoteHauler` | 2/remote source                                           | `[CARRY×2, MOVE×2]` ×8                                                                                                                   | Picks up dropped energy or withdraws from containers in remote room. Opportunistic loot from ruins/tombstones is **energy-only** (DELIVER only transfers energy; picking up minerals would trap them permanently). Delivers to storage/spawns/towers/controller container in home room. Idles near source when waiting for energy. Sized to match local haulers (800 carry) so two haulers can keep up with a reserved source's 10/tick production over long round trips.                                                                                                                                   |
| `hunter`       | 1/infested room (dynamic)                                 | `buildHunterBody`: <790 → not spawned; 790–1309 → `[TOUGH×2, MOVE×4, ATTACK×4, HEAL×1]`; ≥1310 → `[TOUGH×3, MOVE×6, ATTACK×6, HEAL×2]` | Clears NPC Invaders from remote rooms and colony transit rooms. Strictly targets `'Invader'`-owned creeps only. States: TRAVEL (paths to room center, waits for `isInRoomInterior`) → HUNT (attacks lowest-HP invader, self-heals each tick, clears `invaderSeenAt` on room clear) → RETREAT (recycles at home spawn). Spawned at Priority 1 (after defenders, before economy roles). |
| `rangedDefender` | dynamic                                                 | `[RANGED_ATTACK, MOVE]` pairs                                                                                                            | Kites at range 3 from the priority target; uses `rangedMassAttack` when 2+ hostiles in range 3; retreats when gap drops to ≤1. Rallies near spawn when idle. Spawned in compositions with ≥201 threat score. |
| `healer`       | dynamic                                                   | `[HEAL, MOVE]` pairs                                                                                                                     | Follows `partnerName` creep (nearest combatant), heals at range 1 or `rangedHeal` within range 3. Rallies near spawn when partner absent. Spawned in high-threat compositions (>600 threat). |
| `reserver`     | 1/reserved remote room                                    | `[CLAIM×2, MOVE×2]` (1300 energy)                                                                                                        | Continuously calls `reserveController()` on a remote room's controller. 2 CLAIM parts = net +1 tick/tick reservation. Doubles source capacity (1500→3000) and halves container decay. |
| `remoteBuilder` | 0–1/reserved remote room with road sites or damaged roads | `[WORK, CARRY, MOVE×2]` ×4 (1000 energy)                                                                                                | Travels to remote room, gathers energy from containers/drops, builds road construction sites. Falls back to repairing roads below 75% HP. Temporary — stops spawning when roads are built and healthy. |
| `keeperKiller` | 1/SK remote room (RCL 7+, ≥5300 energy)                  | `buildKeeperKillerBody`: <5300 → not spawned; 5300–6999 → `[TOUGH×6, MOVE×10, ATTACK×20, HEAL×4]`; ≥7000 → `[TOUGH×8, MOVE×12, ATTACK×25, HEAL×8]` | Guards Source Keeper rooms. States: TRAVEL → PATROL (cycles keeper lair positions, attacks any SK in range, self-heals) → RETREAT (paths home when TTL < travel time). Prerequisite for SK remote mining opt-in. |
| `claimer`      | 1 (during claiming phase)                                 | `[CLAIM, MOVE×5]` (850 energy)                                                                                                           | Paths to target room controller and calls `claimController()`. Recycles on success. Suicides on `ERR_GCL_NOT_ENOUGH`. |
| `colonyBuilder` | 0–2 (during bootstrapping phase)                         | `[WORK, CARRY, MOVE]` ×4 (bootstrap)                                                                                                    | Dispatched from home room to claimed colony to build the initial spawn. Retires once colony spawn is built. |

Bodies are generated by `buildBody` (`src/utils/body.ts`), which repeats the pattern as many times as `energyCapacityAvailable` allows (default cap: 50 / pattern length). Specialized body builders exist for miners (`buildMinerBody` — maximizes WORK, cap 6), upgraders (`buildUpgraderBody` — maximizes WORK, cap 15), and remote miners (`buildRemoteMinerBody` — WORK+MOVE pairs at 1:1 off-road ratio, plus 1 CARRY for building containers, cap 5 WORK). Non-production roles are capped via `maxRepeats` to control spawning cost: haulers ×8, remote haulers ×8, harvesters ×4, builders ×4, repairers ×4. As the room's energy capacity grows, newly spawned creeps automatically get larger bodies.

### Spawn priority

The spawn queue in `src/managers/spawner.ts` is rebuilt each tick per room by `buildSpawnQueue(room)` and evaluated top-down; the first role below its `minCount` that a spawn can afford is produced, and only one creep is spawned per room per tick.

**Miner economy** (once source containers are built):

0. defender / rangedDefender / healer (dynamic — only when threats active; composition scales with threat score)
1. hunter (dynamic — 1 per Invader-infested remote/transit room, only when `energyCapacityAvailable` ≥ 790)
2. keeperKiller (1 per SK remote room, only when `energyCapacityAvailable` ≥ 5300)
3. miner (1 per source with a container; remote miners are pre-spawned 150 ticks before TTL expiry)
4. hauler (linked sources: 1 total; unlinked: distance-scaled per source, capped at 5; +1 per active remote room; SK/reserved remotes use `isHighCapacity` formula)
5. harvester (0–1 — only emergency bootstrap when a source lacks an assigned miner)
6. upgrader (0–4; at storage < 5k → 1 below RCL 8 / 0 at RCL 8; **young colony RCL < 6**: income-gated aggressive ramp — 1 if score < 20 or builder guard, else 2/3/4 by storage; **mature RCL 6+**: conservative 1/2/3/4 by storage surplus at 100k/200k/500k)
7. builder (0–3, scales with active construction sites; 0 when no sites)
8. repairer (1–2, scales to 2 when >5 damaged structures)
9. mineralMiner (0–1, RCL 6+ when extractor + container + mineral available; throttles when container is full or stockpile reaches `MINERAL_TERMINAL_CEILING` 20k)
10. remote miners (1 per remote source — reuses `miner` role with `targetRoom` set)
11. remoteHauler (distance-aware count per remote source; `isHighCapacity` for reserved/SK rooms)
12. reserver (1 per reserved remote room)
13. remoteBuilder (0–1 per reserved remote room while road sites exist or roads below 50% HP)
14. scout (0–1 — only spawned when unscouted or stale rooms exist)

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

| RCL | Extensions | Towers | Links | Containers          | Storage | Other                                        |
| --- | ---------- | ------ | ----- | ------------------- | ------- | -------------------------------------------- |
| 1   | 0          | 0      | 0     | —                   | —       | —                                            |
| 2   | 5          | 0      | 0     | Source + controller | —       | Roads                                        |
| 3   | 10         | 1      | 0     | "                   | —       | Roads, ramparts                              |
| 4   | 20         | 1      | 0     | "                   | 1       | Roads, ramparts                              |
| 5   | 30         | 2      | 2     | "                   | "       | Roads, ramparts                              |
| 6   | 40         | 2      | 3     | + mineral           | "       | Roads, ramparts, extractor, terminal, 3 labs |
| 7   | 50         | 3      | 4     | "                   | "       | " + 6 labs, factory                          |
| 8   | 60         | 6      | 6     | "                   | "       | " + 10 labs                                  |

- **Extensions** use a compact stamp pattern (`EXTENSION_STAMP`) around the spawn with road corridors on the cardinal axes. Falls back to ring scanning if stamp positions are terrain-blocked.
- **Towers** are placed on ring positions 3–6 tiles from the first spawn.
- **Source containers** are placed at RCL 2+ on the first path step from each source toward the spawn (so they sit on the road, adjacent to the source).
- **Controller container** is placed at RCL 2+ within range 2 of the controller (on the path toward spawn), so upgraders can stand on it and still be in upgradeController range (3).
- **Storage** is placed at RCL 4+ in an open position 2–4 tiles from the first spawn.
- **Links** are placed at RCL 5+. Priority: storage link (within 2 tiles of storage), then source link (within 2 tiles of most distant source), then controller link at RCL 6+ (within 3 tiles of controller).
- **Extractor** is placed on the room mineral at RCL 6+. A mineral container is placed adjacent.
- **Terminal** is placed at RCL 6+ within 1–3 tiles of storage.
- **Factory** is placed at RCL 7+ within 3 tiles of storage. Position is reserved in the layout plan and passes the `isAccessible` check to avoid blocking adjacent extensions.
- **Labs** use a compact stamp pattern (`LAB_STAMP`) anchored 2 tiles from storage. 3 labs at RCL 6, 6 at RCL 7, 10 at RCL 8. The first two labs are designated as input labs; the rest are output labs. All output positions are within Chebyshev range 2 of both inputs, enabling `runReaction()`.
- **Ramparts** are placed at RCL 3+ on spawns, towers, and storage.
- **Roads** start at RCL 2. The manager paths from the spawn to each source, the controller, and storage (when built), placing at most one road site per tick and capping open road sites at 3.

### Economy transition

The room starts in **bootstrap economy** (harvesters self-harvest and deliver) and transitions to **miner economy** when the room planner (`src/utils/roomPlanner.ts`) detects the first source container is built. The transition is automatic and tracked via `RoomMemory.minerEconomy`.

In miner economy:

- Static **miners** (WORK+CARRY+MOVE) sit on source containers and harvest continuously. With CARRY parts, they can transfer energy directly to adjacent links.
- **Haulers** (CARRY + MOVE) use a task commitment system — once a pickup target is selected, the hauler finishes the trip before re-evaluating priorities (only urgent spawn/extension needs can preempt, and not when the hauler is within range 3 of its target). Pickup priority: large dropped energy (≥1000, preempts link drain) → lab flush/input/output → storage link (≥200) → boost-lab service (reserved boost lab stocked with GH2O; active at RCL 7+ when GH2O ≥ 1500 and storage energy above floor) → dropped energy → dropped minerals and ruin/tombstone loot (non-energy skipped when room has no storage or terminal — young colonies have nowhere to deliver) → source-container leg (full ≥1000 then any >0, fullest-first; a `Memory.haulerPool` dispatcher exists but is shelved/dormant — keep it off, it conflicts with task commitment) → factory/terminal logistics. If a hauler somehow acquires a non-energy mineral with no storage or terminal to deliver to, it drops it via `creep.drop()` rather than getting permanently stuck in DELIVER. On delivery, haulers skip the controller container when storage is below floor, and require ≥200 free capacity to deliver to the controller container (preventing trivial top-offs).
- **Upgraders** switch to heavy WORK bodies and withdraw from the controller container or storage instead of self-harvesting. They camp at the controller permanently. Count scales with storage surplus.
- **Builders** and **repairers** gather energy via the shared `gatherEnergy()` helper, which withdraws from logistics infrastructure in miner economy or self-harvests in bootstrap. `withdrawFromLogistics` priority: storage (above floor) → storage link → dropped energy → any source container with >100 energy → gives up (falls back to self-harvest).
- All three roles (builder, repairer, upgrader) respect `STORAGE_ENERGY_FLOOR` (10k) — they won't withdraw from storage below this level. When storage is below floor, creeps drain the storage link (unblocking the link network), pick up dropped energy, or withdraw from source containers (including at linked sources where overflow accumulates).
- One **harvester** is kept as an emergency bootstrap in case all miners die simultaneously.

### Typical progression

1. **RCL 1 (bootstrap):** Two harvesters feed the spawn; two upgraders push the controller toward RCL 2. One builder and one repairer idle-upgrade until there is work.
2. **RCL 2 (transition):** Extensions, roads, source containers, and controller container construction sites appear. Once the first source container is built, the room switches to miner economy — miners, haulers, and heavy-WORK upgraders replace the harvester-based flow. Upgrade throughput jumps significantly.
3. **RCL 3:** The first tower goes up; ramparts are placed on critical structures. The tower manager starts defending, healing, and repairing (holding 50% of its energy in reserve for combat).
4. **RCL 4:** Storage is built; haulers stockpile surplus. Upgrader count scales with storage energy: below 5k → 1 while under RCL 8 (keep the controller progressing) or 0 at a built-out RCL 8 room, 1 below 100k, 2 below 200k, 3 below 500k, 4 above. Upgrader bodies also scale down under scarcity (cap 600 energy below 15k, 1100 below 50k, full above) so a single 15-WORK upgrader doesn't drain reserves faster than miners can refill them. Builders unlock at 10k, upgraders at 15k — the gap lets builders work without a second upgrader competing for energy. Extension stamp fills out to 20.
5. **RCL 5:** Two links are built — storage link (receiver) and source link (sender). Miners transfer energy to the source link; it transfers instantly to the storage link; a hauler empties it. Hauler count drops for linked sources. Second tower comes online.
6. **RCL 6:** Third link (controller or second source). Extractor + mineral container placed on the room mineral; a mineralMiner spawns. Terminal placed near storage. Lab cluster (3 labs) placed via stamp pattern; the lab manager auto-selects reactions from available minerals. Haulers carry minerals to storage/terminal and manage lab input/output logistics.

### Remote mining

Once in miner economy, the AI expands into adjacent unowned rooms for supplemental energy income:

1. A `scout` creep (1 MOVE, cheapest possible) is spawned only when `findScoutTarget()` identifies an unscouted or stale (>5000 ticks) adjacent room **and** the colony is still below its storage-gated remote cap (`remoteRooms.length < remoteRoomCap(room)`). A colony already at its cap gains nothing from more remotes, so it stops scouting instead of continuously re-exploring territory it cannot exploit; scouting resumes automatically if a remote is lost or storage grows. It explores via cross-room PathFinder, recording source count, source positions (`scoutedSourceData`), controller ownership/reservation, and hostile presence into `RoomMemory` scouting fields. Once all rooms are freshly scouted, no scout is spawned — the existing one expires via TTL.

2. Every 100 ticks, `selectRemoteRooms()` (`src/utils/remotePlanner.ts`) evaluates all scouted adjacent rooms. It rejects rooms that are owned, reserved by other players (own reservations are accepted), have no sources, have hostile sightings less than 1500 ticks old (stale sightings from transient invaders are tolerated), or where any player previously classified as `aggressive` (≥3 attacks or maxThreatScore ≥500) has been seen within 20k ticks. The top rooms by source count are stored in `RoomMemory.remoteRooms`, capped at 1 below 100k home storage and 2 above; the second slot is kept with hysteresis until storage drops below 70k, preventing churn when storage oscillates near the threshold.

3. For each remote room, the spawner queues remote miners (1 per source, `buildRemoteMinerBody` — WORK+MOVE pairs for off-road travel plus CARRY for building containers) and remote haulers (2 per source, `[CARRY×2, MOVE×2]` ×4).

4. Remote miners reuse the existing `miner` role with `CreepMemory.targetRoom` set. The `POSITION` state handles cross-room travel by pathing directly to stored source positions via PathFinder with `maxRooms: 2`. Once at the source, the miner places a container construction site and builds it (using its CARRY part), then harvests normally once the container is complete. Remote miners also repair their container when it takes decay damage, using the same CARRY buffer (home miners use theirs for link transfers instead). Container decay (5000 hits/100 ticks) costs ~50 energy and ~10 ticks per cycle — negligible throughput loss. The spawner pre-spawns the next remote miner 150 ticks before its predecessor's TTL expires (`REMOTE_MINER_PRESPAWN_TICKS`), so cross-room travel time doesn't leave the source unmined.

5. `remoteHauler` creeps pick up dropped energy and withdraw from containers in the remote room, then travel home to deliver to storage, spawns, towers, or the controller container. Loot from ruins/tombstones in the remote room is **energy-only** — the DELIVER state only transfers `RESOURCE_ENERGY`, so picking up non-energy minerals would permanently contaminate the hauler's store and eventually leak those minerals into the remote colony via tombstone chains. When waiting for energy in the remote room, haulers idle near the source to avoid border-tile bouncing.

Remote mining roles sit at the bottom of the spawn queue — local economy is never disrupted. `CreepMemory.homeRoom` tracks which room each remote creep belongs to.

### Tower behavior

For each room with towers, each tick (`src/managers/towers.ts`):

1. If any hostile is present, **every tower in the room focus-fires the highest-threat target** (see Defense below). Concentrating fire kills healers before they can negate the damage, which a closest-target approach can fail to do.
2. Otherwise, each tower heals the closest damaged friendly creep.
3. Otherwise, if the tower is at ≥50% energy, it repairs damaged structures (cached per room per tick). Walls and ramparts are repaired up to `wallRepairMax(room)` = `min(max(WALL_FLOOR[rcl], stored × 0.5), WALL_CAPS[rcl])`. `WALL_FLOOR` is a per-RCL minimum HP floor (3=10k, 4=50k, 5=150k, 6=300k, 7=1M, 8=5M) so walls don't stay paper-thin during temporarily lean periods; `WALL_CAPS` is the per-RCL upper bound (3=10k … 8=50M). Ramparts co-located with a wall tile are skipped by the repair scan — they decay naturally at 3 HP/tick, with the underlying wall as the intended long-term barrier. Other structures are repaired below 75% of max HP. The 50%-energy reserve guarantees combat responsiveness when hostiles arrive.

## Defense

`src/managers/defense.ts` coordinates the whole defense stack; `src/utils/threat.ts` scores hostiles by body parts; `src/managers/towers.ts` uses that scoring to focus-fire; `src/roles/defender.ts` is the in-room melee unit.

### Threat scoring (`src/utils/threat.ts`)

Each hostile creep's `threatScore` is the sum of per-part values, ignoring dead parts (`hits === 0`):

| Part            | Score |
| --------------- | ----- |
| `HEAL`          | 250   |
| `CLAIM`         | 200   |
| `RANGED_ATTACK` | 150   |
| `ATTACK`        | 80    |
| `WORK`          | 30    |

`pickPriorityTarget(room)` returns the highest-scoring hostile in a room, breaking ties on current hits ascending (finish the weak ones first). Zero-threat hostiles (scouts, stripped invaders with only TOUGH parts remaining) are still targeted — towers will finish off any hostile in the room.

### Safe mode

`runDefense()` auto-activates safe mode on an owned controller when:

- The controller has `safeModeAvailable > 0` and no cooldown,
- Safe mode is not already active,
- A hostile with `threatScore > 0` is within range 5 of a spawn, the storage, or the controller.

This treats "breach of the base perimeter" as the trigger — scouts wandering the corner of the room don't burn a safe-mode charge.

### Defender spawning

Threat is tracked per room in `RoomMemory.threatLastSeen` / `lastThreatScore`. While the last sighting is within 50 ticks:

```
# Towers fire every tick — skip defenders when they can solo the threat:
if energised towers AND threat <= towers × 500 (THREAT_PER_TOWER)
   AND hostileHeal/tick < towers × 300 (TOWER_DPS_ESTIMATE):
      defendersNeeded = 0
else:
      defendersNeeded = min(ceil(threatScore / 200), 4)
```

A lone invader that a single tower vaporises no longer spawns a wasted defender. The heal check is the safety valve — a squad that out-heals tower fire (the case focus-fire can't win alone) still spawns defenders. The spawner prepends a `defender` request with that `minCount` to the head of the spawn queue. The 50-tick memory window prevents an attacker who briefly steps out of sight from cancelling a defender mid-spawn. When the room has been clear for longer than the window, defender production stops naturally — no standing army in peacetime.

### Perimeter defense (`src/utils/perimeterPlanner.ts`)

The perimeter planner computes a defensive ring around the spawn cluster using BFS flood-fill:

1. **Core zone**: all passable tiles within Chebyshev radius 10 of the spawn anchor.
2. **Exterior set**: BFS from every passable room border tile, blocking terrain walls and core tiles — produces all tiles an attacker can reach without crossing the core.
3. **Perimeter**: exterior tiles (within the buildable range 2–47) that border at least one non-exterior tile.
4. **Gates**: 2-tile-wide openings toward sources outside the core, the controller if distant, and one tile per remote room exit — gate tiles get ramparts (passable by own creeps); all other perimeter tiles get walls (impassable, no decay cost).

The plan is stored as `RoomMemory.perimeterPlan` (~800–1200 bytes) and recomputed automatically when `PERIMETER_PLAN_VERSION` bumps or the set of remote rooms changes. Console: `replanPerimeter(roomName)` forces an immediate recompute.

**RCL-gated build pipeline** (after standard `placeRamparts`):
- RCL 5: `placePerimeterRamparts` — ramparts on all perimeter tiles (walls not yet available)
- RCL 6: `placePerimeterWalls` — walls on non-gate tiles; `placePerimeterRamparts` switches to gate-tiles-only
- Both gated behind `PERIMETER_STORAGE_MIN` (20k storage energy) to avoid energy starvation during build-up

Non-gate perimeter tiles are added to `getPlannedReserved()` so road pathfinding routes through gates automatically.

### Combat event logger (`src/utils/combatLog.ts`)

A ring buffer (max 100 entries) in `Memory.combatLog` records key defense events:

| Event | When logged |
| ----- | ----------- |
| `threat_appeared` | First hostile sighted in a room |
| `threat_ended` | Room confirmed clear after a combat |
| `safe_mode_activated` | Safe mode successfully triggered |
| `safe_mode_unavailable` | Trigger attempted but no charges / on cooldown |
| `tower_energy_low` | Any tower drops below 25% energy during combat |

`logCombat(event)` appends to the buffer and echoes to console. Console: `combatLog()` prints the full log for post-fight review when the room was unobserved.

### NPC Invader response (hunter)

`runDefense()` also tracks NPC Invaders (creeps owned by `'Invader'`) in every visible room — not just owned rooms. When Invaders are seen, `RoomMemory.invaderSeenAt` is set to the current tick; when visibility confirms the room is clear, it is deleted.

`huntersNeeded(homeRoom)` counts how many unique Invader-infested rooms (remote rooms + colony transit rooms) currently lack a hunter. The spawner queues one `hunter` per infested room at Priority 1 (after defenders, before miners) using `buildHunterBody`:

| Energy capacity | Body                                             | Cost  |
| --------------- | ------------------------------------------------ | ----- |
| < 790           | Not spawned                                      | —     |
| 790–1309        | `[TOUGH×2, MOVE×4, ATTACK×4, HEAL×1]`           | 790   |
| ≥ 1310          | `[TOUGH×3, MOVE×6, ATTACK×6, HEAL×2]`           | 1310  |

The hunter uses `isInRoomInterior(creep)` (from `src/utils/movement.ts`) to confirm it is ≥3 tiles from the border before starting the HUNT state — this prevents work logic triggering on a border tile that the engine would auto-evict to the adjacent room. Once in the room, the hunter targets the lowest-HP Invader and self-heals each tick. When the room is confirmed clear it deletes `invaderSeenAt` and retreats home to recycle.

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
- `defense`, `spawner`, `links`, `rooms`, `towers`, `labs`, `terminal`, `construction`, `visuals` — each manager.
- `role.<roleName>` — per-creep dispatch, labelled with the role so hot roles surface separately.

Two console-callable functions are registered once per global reset from `main.ts`:

```text
stats()         // print a sorted table: name / avg / last / max / n
resetStats()    // clear Memory.stats
```

Each `ProfilerSample` (`src/types.d.ts`) tracks `{ avg, last, max, samples }`.

## Visual Debugging

`src/managers/visuals.ts` renders per-room `RoomVisual` overlays for owned rooms. It runs under `profile('visuals', …)` and is gated by `Memory.visuals`, so when disabled it's a single boolean check per tick.

When enabled, for each owned room it draws:

- A header with current RCL, `energyAvailable / energyCapacityAvailable`, economy mode, colony priority score (`score=X.X`), and storage level.
- Controller upgrade progress toward next RCL (hidden at RCL 8).
- A summary of creep counts by role (e.g. `builder:1 harvester:2 repairer:1 upgrader:2`).
- Last-tick CPU (`cpu used / limit`) — matches the `main.loop` entry in `stats()` when profiling is on.
- A `⛏ N` marker above each source showing how many creeps are within range 2 (red when zero — likely an under-served source).
- **Idle creep indicators** — grey circle overlay on creeps with no current task (auto-clears when they get work).
- **Path visualizations** — dashed lines showing each creep's intended path, color-coded by activity. Cross-room paths are filtered to only show segments within the current room.

When `Memory.profileOverlay` is also `true`, draws a sorted CPU stats table (top 12 entries from `Memory.stats` by average cost, coloured red >3ms / yellow >1ms / green ≤1ms) on the first owned room. Toggle independently: `Memory.profileOverlay = true`.

### Path colors

| Color  | Hex       | Activity                                                                                            |
| ------ | --------- | --------------------------------------------------------------------------------------------------- |
| Orange | `#ffaa00` | Gathering energy — miners positioning, haulers picking up, upgraders/builders/repairers withdrawing |
| Green  | `#33ff33` | Builders moving to construction sites                                                               |
| White  | `#ffffff` | Haulers delivering to spawns/extensions/towers/controller container/storage                         |
| Blue   | `#3333ff` | Upgrading controller (upgraders, and builders/repairers falling back to upgrade)                    |
| Red    | `#ff0000` | Defenders attacking hostiles                                                                        |
| Purple | `#cc66ff` | Mineral operations — mineral miner positioning, haulers carrying minerals                           |
| Grey   | `#888888` | Idle creeps rallying toward storage/spawn                                                           |

Extend `runVisuals()` with more overlays (construction plans, tower ranges, etc.) as the AI grows.

## Extending

- **New role:** Add `src/roles/<name>.ts` exporting a `Role`, define states as a `StateMachineDefinition`, register it in `src/roles/index.ts`, extend `CreepRoleName` in `src/types.d.ts`, and add an entry to the spawn queue in `src/managers/spawner.ts`. Use `moveTo()` with appropriate `PRIORITY_*` for movement. If the role can go idle (no work to do), call `markIdle(creep)` from `src/utils/idle.ts`. Add tests in `test/roles/`.
- **New structure placement:** Extend `src/managers/construction.ts` with another `place*` function and an RCL cap map.
- **Smarter pathing / memory:** `CreepMemory` is intentionally minimal — add fields (e.g. `targetId`, assigned source) as roles grow. Put cold per-room planning data on `Memory.rooms[name]` (extend `RoomMemory` in `types.d.ts`) or in a `RawMemory` segment via `src/utils/segments.ts`.
- **New manager or hot path:** Wrap it in `profile('yourLabel', fn)` so CPU cost shows up in `stats()`, and consider memoising expensive finds via `cached(key, () => …)` from `src/utils/tickCache.ts`.
- **New overlay:** Add a draw function to `src/managers/visuals.ts` using `room.visual`; the manager is already gated by `Memory.visuals` and profiled.
- **Tests:** Add or update tests in `test/` when modifying utility functions, manager logic, or role state machines. Run `npm test` before committing.
