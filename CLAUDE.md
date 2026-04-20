# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — Rollup bundles `src/main.ts` into `dist/main.js` + source map. The Screeps runtime loads `dist/main.js` as the AI entry point.
- `npm run watch` — Rollup in watch mode.
- `npm run deploy` — Builds then uploads via `screeps-api upload --branch default dist/main.js`.
- `npm run lint` — ESLint over `src/`.
- `npm run format` / `npm run format:check` — Prettier.
- `npx tsc --noEmit` — Type-check only. Use this as the fast correctness check; there is no test runner configured.

There are no unit tests. `"npm test"` intentionally exits non-zero.

## Architecture

The AI is a single `loop` function exported from `src/main.ts`, called once per tick by the Screeps runtime. The loop is structured as a linear pipeline of managers, each wrapped in `profile(name, fn)` for per-manager CPU accounting.

### Tick pipeline (order matters)

1. `initMemory()` — one-shot Memory shape init (per global reset).
2. `resetTickCache()` — clears the transient per-tick memoisation map.
3. `runDefense` — scans hostiles, updates `RoomMemory.threatLastSeen` / `lastThreatScore`, activates safe mode on perimeter breach. Runs first so the spawner and towers see the same threat view.
4. `runSpawner` — calls `ensureRoomPlan(room)` to refresh source/container/miner cache, then **rebuilds the spawn queue per room** via `buildSpawnQueue(room)`. Uses bootstrap economy (harvester-based) until the first source container is detected, then switches to miner economy (miner + hauler + heavy-WORK upgrader). Defenders are prepended dynamically when threats are active.
5. `runRooms` — purges dead-creep memory, then dispatches each creep to its role via the `roles` registry (`src/roles/index.ts`). Per-creep calls are profiled as `role.<roleName>`.
6. `runTowers` — every tower in a room focus-fires `pickPriorityTarget(room)` (threat-scored, not closest). Falls back to heal → repair with a 50% combat energy reserve.
7. `runConstruction` — one placement per tick (extensions, towers, source containers, controller container, storage, roads), gated by RCL checks in each `place*` function.
8. `runVisuals` — opt-in `RoomVisual` overlay, gated by `Memory.visuals`.
9. `flushSegments` — writes dirty `RawMemory.segments` entries and registers requested segments for next tick.

Reordering these has subtle effects: e.g. moving `runSpawner` ahead of `runDefense` would make defender production lag a tick behind sightings.

### Memory model (three layers, pick the right one)

- **`Memory`** — hot, small. Today: `Memory.creeps[name].role`, `Memory.rooms[name]` (threat fields), `Memory.stats` (profiler), and two toggles (`profiling`, `visuals`). Screeps JSON-parses this blob on first access each tick, so keep it small.
- **`RawMemory.segments` via `src/utils/segments.ts`** — cold/large data (room plans, scout reports, historical stats). Lazy parse on read, dirty-flag writes (only mutated segments serialise at `flushSegments()`). At most 10 segments may be active per tick; use `requestSegment(id)` to queue for next tick.
- **`src/utils/tickCache.ts`** — within-tick memoisation, cleared by `resetTickCache()`. Use `cached(key, () => expensive())` when multiple managers need the same `room.find` / aggregate.

`src/utils/memoryInit.ts` guarantees `Memory.creeps` and `Memory.rooms` exist after a global reset so hot-path code doesn't need `??= {}` guards.

### Adding a role

1. Create `src/roles/<name>.ts` exporting a `Role` (`run(creep): void`).
2. Register it in `src/roles/index.ts`.
3. Extend the `CreepRoleName` union in `src/types.d.ts`.
4. Add a `SpawnRequest` entry in `buildSpawnQueue()`. Prefer a dynamic `*Needed(room)` function (see `buildersNeeded`, `repairersNeeded`, `upgradersNeeded` as examples) over a hardcoded `minCount`. Every role's count should reflect current room state so the economy self-balances.

The TypeScript union + `Record<CreepRoleName, Role>` in the registry means forgetting any of these steps is a compile error.

### Body scaling

`src/utils/body.ts` `buildBody(pattern, energy, maxRepeats?)` repeats a body pattern as many times as the room's `energyCapacityAvailable` allows. Spawner always passes `spawn.room.energyCapacityAvailable`, so creeps automatically grow as extensions get built — do not hardcode bodies.

### Defense

- `src/utils/threat.ts` scores hostile creeps by body parts (HEAL 250 > CLAIM 200 > RANGED_ATTACK 150 > ATTACK 80 > WORK 30; dead parts ignored). `pickPriorityTarget(room)` returns the top-scoring hostile with a hits-ascending tiebreak.
- Focus-fire (`managers/towers.ts`) is the deliberate policy — closest-target fire lets healers keep attackers alive indefinitely.
- Safe mode activates only when a hostile with `threatScore > 0` is within range 5 of a spawn / storage / controller, so scouts don't burn a charge.
- `defendersNeeded(room)` = `min(ceil(threatScore / 200), 4)` while `threatLastSeen` is within 50 ticks. The memory window prevents an attacker stepping briefly out of view from cancelling an in-progress defender spawn.

### Profiling & visuals (opt-in)

Both gated by Memory flags so production ticks pay ~nothing when off:

- `Memory.profiling = true` → `profile(name, fn)` records CPU deltas as exponential moving averages in `Memory.stats`. `installProfilerGlobals()` (called once per global reset from `main.ts`) exposes `stats()` and `resetStats()` as console globals.
- `Memory.visuals = true` → `runVisuals()` draws per-room RCL/energy/creep-count/CPU headers and source-load markers.

When adding a new manager or hot path, wrap it in `profile('label', fn)` so it surfaces in `stats()`.

### Error mapping

`src/utils/ErrorMapper.ts` wraps the main loop with `wrapLoop`. It uses a custom synchronous VLQ decoder (not the `source-map` package, which is async and too slow for Screeps) to map runtime errors back to TypeScript source lines. The bundled `main.js.map` is loaded via Screeps' `require('main.js.map')`; the parsed map is cached across ticks and rebuilt on global reset.

## TypeScript / Screeps specifics

- `tsconfig.json` uses `strict` + `noUncheckedIndexedAccess`. `Game.creeps[name]` and similar index accesses return `T | undefined` — always null-check.
- `lib` is `ES2021` (no DOM). A minimal `console` and `require` are declared in `src/types.d.ts` for the Screeps sandbox globals. Do not add `@types/node`.
- The rollup bundle marks `lodash` as external because Screeps provides it globally. Do not import lodash in new code — use native `Object.values` / array methods (this was a deliberate cleanup).
- `"type": "commonjs"` in `package.json`; rollup outputs CJS because the Screeps VM is CJS.

## Source of truth

README.md is kept factual against the current source and covers the same material at more length. todo.md tracks outstanding work in priority order; check it before starting anything ambitious so you don't duplicate a staged plan (e.g. non-energy resource harvesting already has a detailed RCL-gated plan laid out).
