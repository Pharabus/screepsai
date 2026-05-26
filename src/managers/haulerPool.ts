/**
 * Hauler pool dispatcher.
 *
 * ⚠️ SHELVED / DORMANT — do NOT enable `Memory.haulerPool`. Live validation
 * (v1.0.189, W44N57) showed this naive pool conflicts with the hauler's
 * task-commitment model: committed haulers ignore their assignment
 * (`continueCommittedPickup` short-circuits first), and haulers the dispatcher
 * leaves unassigned fall through to the legacy fullest-first pick — net effect
 * was WORSE convergence than legacy. It stays here behind the off-by-default
 * flag as a verified no-op. Making it work needs a commitment-aware + sticky
 * dispatcher (pre-deduct already-committed haulers' capacity from their
 * container's need) AND the flag-on path must fully replace the legacy
 * source-container steps so extras don't re-converge. Revisit at 3+ colonies /
 * many unlinked sources (see todo.md Phase 6). For now the commitment-based
 * per-hauler selection in hauler.ts is the working approach.
 *
 * Assigns home haulers to source containers so fuller containers get
 * proportional coverage and haulers spread across sources rather than
 * all converging on the globally-fullest one.
 *
 * Gated by `Memory.haulerPool` (default off, dark-deploy safe).
 * Consulted only at the two source-container pickup steps in hauler.ts;
 * all other hauler behaviour is completely unchanged.
 *
 * Algorithm — greedy fill+proximity:
 *   1. Collect source containers with energy > 0 (excluding controller +
 *      mineral containers).
 *   2. Collect home haulers currently in PICKUP state with free capacity.
 *   3. Repeat until no unassigned haulers remain or all containers are
 *      satisfied:
 *      a. Pick the container with the highest remaining need
 *         (containerEnergy − Σ freeCapacity of already-assigned haulers).
 *         Tie-break by container id (lexicographic → deterministic).
 *      b. Among unassigned haulers, pick the nearest to that container
 *         (Chebyshev range). Tie-break by name (lexicographic → deterministic).
 *      c. Record the assignment; deduct the hauler's free capacity from the
 *         container's remaining need.
 *   4. Extra haulers (more haulers than total container energy needs) are left
 *      unassigned — they fall through to other pickup logic / markIdle.
 *
 * Returns a map of creepName → assigned containerId, tick-cached per room so
 * every hauler call in the same tick shares one computation.
 */

import { cached, getStructuresByType } from '../utils/tickCache';

export function assignHaulers(room: Room): Record<string, Id<StructureContainer>> {
  return cached(`haulerPool:${room.name}`, () => {
    const mem = Memory.rooms[room.name];
    const controllerContainerId = mem?.controllerContainerId;
    const mineralContainerId = mem?.mineralContainerId;

    // Source containers with energy (exclude controller + mineral containers)
    const containers = (
      (getStructuresByType(room)[STRUCTURE_CONTAINER] ?? []) as StructureContainer[]
    ).filter(
      (c) =>
        c.id !== controllerContainerId &&
        c.id !== mineralContainerId &&
        c.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
    );

    if (containers.length === 0) return {};

    // Home haulers in PICKUP state with free capacity — the only ones that
    // will ever reach the source-container pickup step.
    const haulers = Object.values(Game.creeps).filter(
      (c) =>
        c.memory.role === 'hauler' &&
        c.memory.homeRoom === room.name &&
        c.memory.state === 'PICKUP' &&
        c.store.getFreeCapacity() > 0,
    );

    if (haulers.length === 0) return {};

    // Mutable remaining-need tracking per container
    const needs = containers.map((c) => ({
      container: c,
      remaining: c.store.getUsedCapacity(RESOURCE_ENERGY),
    }));

    const unassigned = [...haulers];
    const assignment: Record<string, Id<StructureContainer>> = {};

    while (unassigned.length > 0) {
      // Pick the container with the highest remaining need (> 0).
      // Tie-break by id so output is deterministic across ticks.
      let best: (typeof needs)[0] | undefined;
      for (const n of needs) {
        if (n.remaining <= 0) continue;
        if (
          !best ||
          n.remaining > best.remaining ||
          (n.remaining === best.remaining && n.container.id < best.container.id)
        ) {
          best = n;
        }
      }

      if (!best) break; // All containers satisfied — leave remaining haulers unassigned

      // Pick the nearest unassigned hauler to the chosen container.
      // Tie-break by name so output is deterministic.
      // (unassigned.length > 0 is guaranteed by the while condition)
      let nearestIdx = 0;
      let nearestCreep = unassigned[0];
      if (!nearestCreep) break; // should never happen given while condition

      let nearestRange = nearestCreep.pos.getRangeTo(best.container);
      for (let i = 1; i < unassigned.length; i++) {
        const candidate = unassigned[i];
        const current = unassigned[nearestIdx];
        if (!candidate || !current) continue;
        const r = candidate.pos.getRangeTo(best.container);
        if (r < nearestRange || (r === nearestRange && candidate.name < current.name)) {
          nearestRange = r;
          nearestIdx = i;
          nearestCreep = candidate;
        }
      }

      assignment[nearestCreep.name] = best.container.id;
      best.remaining -= nearestCreep.store.getFreeCapacity();
      unassigned.splice(nearestIdx, 1);
    }

    return assignment;
  });
}
