# Harabi's Bot Design Approaches

Source: https://sy-harabi.github.io/ — a highly respected Screeps bot author.
Captured 2026-05-24 for use in refining this bot. All credit to Harabi.

---

## 1. Mission Architecture — Emergent Coordination via Hierarchy

Harabi's architecture is built around three layers: **Managers → Missions → Creeps**.

- **Managers** are persistent top-level entities that own a domain (Room, Combat, Expansion). They maintain baseline responsibilities and spawn Missions when goals arise.
- **Missions** are goal-oriented units with explicit success/failure conditions. Missions can recursively spawn sub-missions, e.g. `TotalWar → Siege → Quad`. This decomposition is the primary source of strategic flexibility.
- **Creeps** are pure executors. They receive orders from their Mission and act; they make no strategic decisions.

**The one coordination rule**: *A mission may read any mission's memory, but may only write to its own.*
This single constraint produces emergent coordination. Higher-level missions observe child mission state and adapt without explicit signalling channels — no event bus, no callbacks, just reads.

**Execution cycle per tick**: Analyze → Deploy → Resolve → Act.
Separation of strategic evaluation (Resolve) from local execution (Act) is intentional — it allows child missions to finish acting before parents reassess them.

**Memory layout**: `Memory.missions[type][id]` — fast lookup by type, iteration across all instances.

**Relevance to our bot**: Our current architecture (linear manager pipeline, roles as flat state machines) is closer to Harabi's "Creeps" layer only. A Mission layer between spawner decisions and role execution would let us express compound goals (e.g. claim a room, defend under siege, manage SK rooms) more naturally than bolting more flags onto `RoomMemory`.

---

## 2. Logistics — Empire-Level Thinking, Minimal Movement

Two guiding rules underpin the entire logistics system:

1. **Think at bot-level, not room-level.** Resource decisions are made across the whole empire, not per-room.
2. **Do not send resources unless necessary.** The default state is: resources stay where they are.

### Mineral threshold management
Rather than equalizing minerals across rooms, a single empire-wide threshold governs behavior:
- `threshold = threshold_per_room × total_rooms`
- Above threshold → sell surplus on market.
- Below threshold → buy from market.
- The pigeonhole principle does the balancing work naturally; no redistribution loop is needed.

### Lab targeting
When labs are idle and choosing a reaction, score candidates by:
`(current empire stock) / (desired empire stock)` — lowest ratio wins.
This considers minerals already in production elsewhere to avoid redundant parallel runs.

### Resource request criteria
Transfers are only initiated for specific justified scenarios:
- Lab ingredient staging
- Creep boost preparation
- RCL acceleration funnelling to a target room
- Emergency low-energy recovery
- Parallel power processing
- Nuker preparation

All transfers route from the **geographically closest** suitable source to minimise market/terminal energy costs.

### Overflow handling
When storage is full: push excess energy first. If not excess energy, distribute the most abundant non-energy resource to the nearest room with capacity.

**Relevance to our bot**: Our current terminal logic is reactive and per-room. A bot-level threshold model would let us stop thinking about individual room minerals and instead just manage empire totals. Our `MINERAL_TERMINAL_CEILING` constant is a rudimentary version of this, but it doesn't account for empire need before selling.

---

## 3. Energy Income — Precision Over Abundance

Eight principles Harabi treats as foundational for energy income efficiency:

### 3.1 Specialise: static miners + haulers
Split workers into dedicated roles. Generalist workers leave parts idle. Static miners (WORK+MOVE, sit on source) and haulers (CARRY+MOVE only, transport) maximise utilisation of every body part.

### 3.2 Remote mining
Home rooms cap at 20 energy/tick (2 sources × 10). Remote sources are the only way to scale past this ceiling. Expand outward as spawn time and CPU allow.

### 3.3 Containers + roads as infrastructure investment
- Containers beside each source: buffer miner output, prevent decay, allow asynchronous hauler pickup.
- Roads between source → storage: halve fatigue, enable 2:1 CARRY:MOVE ratio on haulers (vs 1:1 on plain terrain). This directly reduces hauler body cost and spawn time.

### 3.4 Right-size haulers — avoid over-spawning
Calculate exact CARRY capacity needed: `(source output per tick) × (round-trip ticks)`. Spawn to that number, not above. Idle haulers are a net drain on energy, CPU, and spawn bandwidth.

### 3.5 Choose remotes by proximity
Distance multiplies every cost: energy hauled per trip drops, hauler body cost rises, CPU for pathfinding increases. Always fill closest rooms first. Expand outward only when spawn capacity permits.

### 3.6 Source Keeper rooms (RCL 7+)
SK sources yield 4,000 energy per 300 ticks vs 3,000 standard — a 33% income premium. SK tombstones also drop energy. Requires dedicated killer creeps (ATTACK+MOVE+HEAL). The complexity is justified by the income gain at scale.

### 3.7 Hauler pool (advanced)
Instead of assigning haulers 1:1 to sources, treat all haulers as a shared pool. A centralised dispatcher assigns available haulers to whichever container is fullest / most urgent. Eliminates fractional waste (e.g. a source needing 2.5 haulers). Requires more complex scheduling logic but reduces total hauler count needed.

**Status: implemented but SHELVED — do NOT enable.** `src/managers/haulerPool.ts` has a greedy fill+proximity dispatcher for the source-container leg, gated by `Memory.haulerPool` (off by default). Live validation (v1.0.189, W44N57) showed the naive pool conflicts with our task-commitment model — committed haulers ignore the assignment and unassigned extras fall through to legacy fullest-first, giving *worse* convergence than legacy. Kept dark as a verified no-op pending a commitment-aware + sticky rewrite; revisit at 3+ colonies / many unlinked sources. Our commitment-based per-hauler selection works well for the current empire. See `todo.md` Phase 6.

### 3.8 Visualise everything
- `RoomVisual`: per-room dashboards (source status, assigned creeps, metrics).
- `MapVisual`: empire-wide remote mining network overview.
- `creep.say()`: creep-level task reporting for debugging.
Visibility surfaces inefficiencies before they compound.

**Relevance to our bot**: Our hauler count formula already approximates 3.4 (path-distance based). The hauler pool (3.7) is the most significant gap — we assign haulers by room, not dynamically. SK rooms (3.6) are now live but nascent.

---

## 4. Creep Boosting — Robust Multi-Phase Pipeline

Harabi's boosting system is a three-phase pipeline with explicit rollback:

**Phase 1 — Gather**: Validate resource availability across the room. Import via terminal if minerals or energy are insufficient.

**Phase 2 — Prepare**: Pause active reactions. Route courier creeps to carry correct minerals to designated labs. Batch multiple boost requests together. Wait for the creep to finish spawning before proceeding.

**Phase 3 — Boost**: Target creep navigates to labs. Each lab boosts the creep until the full recipe is applied.

### Safety mechanisms that matter
- Only create a boost request after spawn confirmation (no phantom requests).
- Verify target creep is alive before initiating the boost phase.
- Prefer labs already holding the needed mineral (avoids unnecessary mineral movement).
- Account for energy cost alongside mineral cost.
- Implement phase rollback on failure.
- Apply per-request timeouts to abandon stalled requests.
- For multi-creep teams: renew members spawned early if the team assembly takes too long.

**Request processing order**: oldest-first, for fair allocation.

**Relevance to our bot**: We have no boosting system. When we add it (post Phase 4), this pipeline is the reference design — the phase/rollback model is particularly important to avoid lab state corruption.

---

## 5. Quad Attack — Coordinated 2×2 Combat Formation

Primarily relevant for PvP and Stronghold content (not our current priority), but the architectural principles transfer.

### Formation mechanics
4 creeps move as a unified 2×2 block. All movement, attack, and heal decisions are made for the group, not individually.

### Body composition (RCL 8 Level-1 Stronghold)
Per creep: 10 RANGED_ATTACK, 25 MOVE, 15 HEAL. 60 total HEAL across the quad to sustain ~600 damage/tick.

### Attack targeting
Each creep attacks the highest-priority target in range 3. Priority: enemy creeps first, then structures.

### Healing strategy
"Maximise the lowest expected health among your creeps." Each tick, calculate which creep will have the lowest HP after incoming damage, then heal that creep. This keeps the weakest link alive longest.

### Movement architecture
Three-layer pathfinding:
1. **Obstacle map**: tile costs weighted by structure hit points (harder structures = higher cost).
2. **Destruction cost matrix**: project individual tile costs onto 2×2 quad footprint.
3. **Target selection**: first destructible structure along the computed path becomes the immediate attack target.

### Danger/retreat
Calculate incoming tower damage at each position. Retreat when projected damage exceeds total quad heal capacity. Remember entry points to path back to room exits.

**Relevance to our bot**: Quad capability is deep future work, but the pathfinding layers (obstacle → formation cost → target) are a clean model for any structured combat role.

---

## Summary: Gaps vs. Our Current Architecture

| Harabi Approach | Our Bot Status |
|---|---|
| Mission hierarchy (Manager→Mission→Creep) | Flat pipeline — no mission layer |
| Empire-level logistics thresholds | Per-room logic, per-room terminal rules |
| Hauler pool (dynamic dispatch) | Fixed per-room hauler counts |
| Creep boosting pipeline | Not implemented |
| Bot-level mineral threshold (sell/buy) | Sell-only above ceiling, no empire view |
| SK rooms with dedicated killer | Implemented (nascent) |
| Road-optimised hauler body sizing | Implemented (path-distance aware) |
| Visual dashboards (`MapVisual`) | Per-room only, no empire overlay |
| Quad / structured PvP combat | Not planned yet |
