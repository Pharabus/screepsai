# Suggestions — Faster Controller Upgrading

Options for speeding up RCL progression, presented by effort/impact tier. No code changes yet; most options are inter-related, so picking one often makes the next cheap.

## Quick wins (same-tick, single-file changes)

1. **Heavy-WORK upgrader bodies.** Every `WORK` upgrades 1 energy/tick; every extra `CARRY`/`MOVE` is pure overhead. Current pattern `[WORK, CARRY, MOVE]` repeated = 1 WORK per 200 energy. A pattern like `[WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE]` gives ~4× the WORK per unit energy for the upgrader specifically. `src/managers/spawner.ts` already takes a per-role `pattern` — this is a one-line change per role.
2. **Same for harvesters.** Give harvesters (or a new static `miner`) a heavy-WORK pattern like `[WORK, WORK, WORK, WORK, WORK, MOVE]` — 5 WORK fully drains a 3000-energy source in its 300-tick regen window. Right now two 1-WORK harvesters under-drain the source.
3. **Range-aware pathing.** `upgrader.ts` calls `creep.moveTo(controller)` — default stops at range 1. `upgradeController` has range 3, so upgraders waste 2 tiles of travel every cycle. `moveTo(controller, { range: 3 })` fixes it; same trivially applies to `builder.ts` / `repairer.ts` fallback branches.
4. **Bump `upgrader` minCount.** If sources are under-drained, simply spawning more upgraders is free progress. You can already see this in `stats()` if profiling is on — source load vs. upgrader idle time tells you whether you're source-limited or upgrader-limited.
5. **Don't wait until empty to refill.** Upgraders currently only refill when `usedCapacity === 0`. For a heavy-WORK upgrader standing adjacent to the controller, that's a long round-trip dead zone; refilling earlier (or never leaving the controller — see option 7) is a much bigger win.

## Medium (logistics restructure — biggest single jump)

6. **Dedicated hauler + static workers.** The core reason upgrading is slow is that upgraders are also harvesters: half their life is in transit. Pattern:
   - Static `miner` sits on a container next to each source (3–5 WORK).
   - `hauler` (`[CARRY, CARRY, MOVE, MOVE]`) moves energy from source containers to spawn/extensions/controller container.
   - Upgraders stop harvesting entirely and camp by the controller.

   This is already the Stage 1 plan in `todo.md`; doing it purely for upgrade throughput is a legitimate reason to pull it forward.
7. **Upgrader container at the controller.** Place a container within 3 tiles of the controller. Upgraders stand on/next to it, pull from the container with `withdraw`, and never move. Combined with option 6, one big upgrader can do the work of several walking ones — often 5–10× faster RCL gain at RCL 3–4.
8. **Storage-driven upgrading (RCL 4+).** Once `Memory.rooms` has a storage slot, upgraders withdraw from storage directly if placed adjacent, or a hauler refills the upgrader container from storage. Storage smooths over harvest bursts so upgraders never starve.
9. **Roads to controller.** Already happening at RCL 2+ in `managers/construction.ts`. Verify in-game — if they're not built yet, that's a ~2× pathing speedup for free.
10. **Dynamic role counts from room economy.** Instead of hardcoded `minCount: 2`, derive counts from source throughput: `desiredUpgraders = floor(sourceWorkCapacity / upgraderWorkParts)`. This lands correctly at every RCL instead of being under/oversized.

## Longer-term

11. **Links (RCL 5+).** Source link → controller link eliminates hauler round-trips entirely. Energy materialises next to the upgrader. This is the endgame for steady-state upgrading.
12. **One maxed upgrader at RCL 8.** Above RCL 8 the controller caps at 15 energy/tick, so the optimal config is a single creep with 15 WORK + minimal CARRY + 1 MOVE on a road tile, fed by a link. Pre-RCL-8 there's no cap, so more/bigger upgraders always help.
13. **Boosts (RCL 6+, needs labs).** `XGH2O` boost triples `upgradeController`. Irrelevant until labs land, but worth noting because Stage 3 in `todo.md` already plans labs.
14. **GCL-aware upgrade targeting.** At very low GCL, emptying every tick of excess energy into the controller (even via overflow builders) is good; at higher GCL or approaching RCL 8 you want to throttle. Room-memory policy flag.

## Diagnostics first

Before picking: turn on profiling (`Memory.profiling = true`) and visuals (`Memory.visuals = true`) and read:

- **`stats()`** — if `role.upgrader` CPU is low per upgrader, upgraders are idle (starved for energy → fix logistics, options 1/6/7). If it's high, they're busy (→ bump count or body size, options 1/4).
- **Source load markers (`⛏ N`)** — red / low numbers mean sources aren't drained (→ heavier harvesters, option 2). Consistently green means you're source-limited and more upgraders won't help without remote mining.

That tells you whether the bottleneck is **energy supply** (options 2, 6, 7, 11) or **conversion capacity at the controller** (options 1, 3, 4, 12), so you don't spend effort on the wrong side.
