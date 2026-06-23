---
name: CreepStatus
description: Show all creeps in a room with their position, role, state, TTL, and cargo, then flag anomalies like stuck creeps, spawning delays, or creeps in unreachable areas. Use when the user asks about stuck/stalled creeps, movement issues, or wants a snapshot of creep activity in a room.
---

# CreepStatus

Produces a table of all creeps in a room with position, role, state, TTL, and cargo. Flags
anomalies: creeps that appear stuck, creeps in unusual states, low-TTL creeps, and creeps
at spawn positions (freshly spawned or blocked).

Uses `scripts/screeps-query.mjs` — never MCP.

## How to run it

The skill takes a room name argument (e.g. `/CreepStatus W44N57`).

### Step 1 — set the target room and run the probe

```bash
/usr/bin/node scripts/screeps-query.mjs run "Memory._probeRoom='ROOM'" && \
/usr/bin/node scripts/screeps-query.mjs probe scripts/probes/creepStatus.js
```

Replace `ROOM` with the actual room name. Use a **150-second timeout**.

The result is JSON: `{rm, tick, creeps[]}`. Each creep has:
`{name, role, x, y, state, ttl, carry, home, target, fatigue}`.

### Step 2 — render the table

Sort creeps by role, then by name. Render as:

```
Creeps in ROOM @ tick TICK — N total

Role            Position  State     TTL   Cargo      Home      Target    Flags
─────────────── ───────── ──────── ───── ────────── ───────── ───────── ──────
hauler          25,7      DELIVER   1200  750/800   W44N57              
miner           40,21     HARVEST   1100  0/50      W44N57              
remoteHauler    27,3      TRAVEL    800   0/1600    W44N57    W44N58    ⚠ bottleneck
upgrader        16,10     WORK      900   50/50     W44N57              
```

### Step 3 — flag anomalies

Check each creep and add flags in the last column:

- **`⚠ at spawn`** — creep position matches a known spawn position AND state is not a
  transit state (POSITION, TRAVEL). A creep lingering at a spawn blocks it.
- **`⚠ bottleneck`** — creep is at a known bottleneck tile (e.g. single-tile corridor).
  Not an error, but explains congestion. Common positions: tiles adjacent to room borders
  (x/y = 0,1,48,49), or known chokepoints from `/RoomLayout`.
- **`⚠ border`** — creep at x/y = 0 or 49. Engine may auto-evict. Roles should use
  `isInRoomInterior` before starting work.
- **`⚠ low TTL`** — TTL < 100 and not a miner (miners pre-spawn replacements).
- **`⚠ wrong room`** — creep's `home` is this room but `target` is a different room,
  yet the creep is IN the home room with state other than GATHER/DELIVER/PICKUP.
  May indicate the creep can't path to its target.
- **`⚠ fatigue`** — fatigue > 0 on a creep that should be on roads. Indicates off-road
  movement or missing roads.
- **`⚠ empty hauler`** — hauler/remoteHauler in DELIVER state with 0 cargo.
  May be stuck in a deliver loop with nothing to deliver.
- **`⚠ full miner`** — miner with full carry capacity. Container may be missing or full,
  or the miner can't reach it.

### Step 4 — summary

After the table, add a one-line summary:

```
Summary: N creeps, M flagged. [description of most notable issue if any]
```

## Repeated snapshots

If the user wants to check if creeps are stuck (same position across ticks), run the probe
twice with a ~30-second gap and compare positions. A creep at the exact same tile with the
same state across both snapshots is likely stuck. Report these prominently.

## Fallback

If the probe times out, use:
```bash
/usr/bin/node scripts/screeps-query.mjs run "JSON.stringify(Object.values(Game.creeps).filter(function(c){return c.room&&c.room.name=='ROOM'}).map(function(c){return c.memory.role+':'+c.pos.x+','+c.pos.y+'('+c.memory.state+')'}))"
```

This returns a compact array of `role:x,y(state)` strings — enough for basic triage without
the full detail.
