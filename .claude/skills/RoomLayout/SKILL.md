---
name: RoomLayout
description: Render an ASCII grid of a room's structures, construction sites, roads, and terrain, then run flood-fill reachability analysis from the spawn to flag unreachable positions and single-tile bottlenecks. Use when the user asks about layout issues, blocked structures, stranded extensions/labs, or cramped areas in a room.
---

# RoomLayout

Produces a labeled ASCII grid of a room's core (28x28 around the primary spawn) showing
structures, construction sites, roads, and terrain. Then performs a flood-fill reachability
analysis to flag unreachable structures/sites and single-tile-corridor bottlenecks.

Uses `scripts/screeps-query.mjs` — never MCP.

## How to run it

The skill takes a room name argument (e.g. `/RoomLayout W44N57`).

### Step 1 — set the target room and run the probe (two chained commands)

```bash
/usr/bin/node scripts/screeps-query.mjs run "Memory._probeRoom='ROOM'" && \
/usr/bin/node scripts/screeps-query.mjs probe scripts/probes/roomLayout.js
```

Replace `ROOM` with the actual room name. Use a **150-second timeout** — console latency
is variable. If it times out, retry once. If it times out again, fall back to
`/usr/bin/node scripts/screeps-query.mjs mem rooms.ROOM.layoutPlan` for the cached plan
(no live structure data, but enough for plan-vs-built comparison).

The result is JSON: `{rm, anc, st[], si[], rd[], g{}}`.

### Step 2 — build the grid

Create a 2D grid from `anc.x ± 14`, `anc.y ± 14` (the probe's radius). For each tile:

1. **Terrain base** — if `g["x,y"]` exists: `1` = wall (`██`), `2` = swamp (`~~`). Missing = plain (`. `).
2. **Road overlay** — if `"x,y"` is in `rd[]`: `++`.
3. **Structure overlay** (overwrites road) — match `st[]` entry by x,y:
   - `spa` → `SP`, `ext` → `EX`, `tow` → `TW`, `sto` → `ST`, `ter` → `TR`
   - `lab` → `LB`, `fac` → `FC`, `lin` → `LK`, `con` → `CN`, `ext` → `EX`
   - `spa` → `S1`/`S2` (number spawns in order of appearance)
   - Foreign structures (`my: false`): prefix with `!` (e.g. `!ST`)
4. **Construction site overlay** — match `si[]` by x,y: same abbreviation but wrapped in `*` (e.g. `*LB`).

Print with **column headers** (x mod 10) and **row labels** (y). Keep cells 2-3 chars wide
with a space separator for readability.

### Step 3 — flood-fill reachability analysis

Starting from the primary spawn position (`anc`), do an 8-directional flood fill:

- **Walkable tile** = not a wall (terrain `1`), not occupied by a non-walkable structure
  (`spa`, `ext`, `tow`, `sto`, `ter`, `lab`, `fac`, `lin`, `obs`, `pow`, `nuk`).
  Roads, containers, and ramparts are walkable. Construction sites of obstacle types
  (`ext`, `spa`, `tow`, `lab`, `ter`, `lin`, `fac`, `sto`) are **impassable** in the
  Screeps engine.
- Mark the spawn tile and all 8-connected walkable tiles as **reachable**.

Then check every structure in `st[]` and every site in `si[]`:
- For each, check if **any** of its 8 neighbours is reachable.
- If none are reachable → flag as **UNREACHABLE**.

### Step 4 — bottleneck detection

For each reachable walkable tile, count how many of its 8 neighbours are also reachable and
walkable. If a tile has only **1** reachable walkable neighbour (a dead-end corridor), flag it
as a potential **bottleneck**. Group adjacent bottleneck tiles into corridors and report the
narrowest chokepoints.

### Step 5 — render the report

```
Room Layout — ROOM @ tick (from probe)

  [ASCII grid here]

Structures: N built, M sites
Reachability:
  OK: all structures/sites reachable from spawn
  — or —
  UNREACHABLE: lab at (29,10), extension at (30,9), ...

Bottlenecks:
  (27,3) — 1-tile corridor connecting north to core
  — or —
  No critical bottlenecks found

Notes:
  [any anomalies: foreign structures, unusual construction sites, etc.]
```

## Interpretation guide

- **UNREACHABLE** structures/sites are the priority — builders can't reach them, haulers
  can't service them. Fix by destroying a blocking extension/structure to open a path, then
  splice the position from the cached plan and place a road to prevent rebuilding.
- **Bottlenecks** cause traffic jams but are functional. Flag 1-tile corridors that carry
  remote traffic (path from exits to core) — these cause the "stalled creeps" symptom.
  Fix by destroying an extension to widen, but this is a tradeoff (extension vs. throughput).
- **Foreign structures** (`!` prefix) in a reclaimed room should be destroyed by
  `cleanupClaimedRoom` — if they persist, something is wrong.
- **Construction sites** for obstacle types on live corridors will block movement once the
  structure is built — flag if they're on the only path to another structure.
