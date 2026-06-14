import { moveTo } from './movement';
import { PRIORITY_WORKER } from './trafficManager';

/**
 * Max ticks a creep will wait in range of the boost lab for a compound that is
 * present in storage/terminal but has not yet been delivered to the lab. Past
 * this it fails open and proceeds unboosted. The compound delivery can be
 * starved indefinitely by higher-priority hauler work (e.g. the storage-link
 * drain monopolising every hauler), and an idle creep is strictly worse than an
 * unboosted working one. The hauler-side fix (boost-lab service preempts the
 * link drain when a creep is awaiting the compound, see hauler.ts) means this
 * bound is rarely reached — it is a safety net, not the primary mechanism.
 */
const BOOST_WAIT_TIMEOUT = 50;

/**
 * Gate function called at the top of a creep's role `run()` before any role
 * logic executes.
 *
 * Returns `true`  → proceed with the role (either no boosts pending, or all
 *                    boosts have been applied).
 * Returns `false` → still boosting; the role should `return` immediately this
 *                    tick without doing any role work.
 *
 * Behavioral rules (one boost entry is processed per call):
 * 1. No `boosts` field or empty array → return true immediately.
 * 2. Skip entries where all parts of the given type are already boosted.
 * 3. Resolve a lab:
 *    a. If `Memory.rooms[room].boostLabId` is set, use that lab unconditionally
 *       (even if understocked — a hauler is on the way, so we wait).
 *    b. Otherwise search room for a StructureLab that holds the compound with
 *       enough stock for all unboosted parts of the requested type.
 *    c. If no lab can be resolved → fail-open (delete boosts, return true).
 * 4. Not in range 1 → moveTo lab and return false.
 * 5. In range → call lab.boostCreep(creep):
 *    - OK                    → remove entry; return true if done, false if more.
 *    - ERR_NOT_ENOUGH_RESOURCES → return false (wait for refill).
 *    - any other code        → fail-open (delete boosts, return true).
 */
export function ensureBoosted(creep: Creep): boolean {
  const boosts = creep.memory.boosts;
  if (!boosts || boosts.length === 0) {
    return true;
  }

  // Find the first entry that still has unboosted parts
  while (creep.memory.boosts && creep.memory.boosts.length > 0) {
    const entry = creep.memory.boosts[0];
    if (!entry) {
      creep.memory.boosts.shift();
      continue;
    }

    const { part, compound } = entry;

    const partCount = creep.body.filter((bp) => bp.type === part && bp.boost === undefined).length;

    if (partCount === 0) {
      // All parts of this type already boosted — skip to next entry
      creep.memory.boosts.shift();
      continue;
    }

    // Resolve the boost lab
    let lab: StructureLab | null = null;

    const roomMem = Memory.rooms[creep.room.name];
    if (roomMem?.boostLabId && roomMem.boostCompound === compound) {
      const reserved = Game.getObjectById(roomMem.boostLabId);
      if (reserved) {
        // Use the reserved lab regardless of stock — a hauler is filling it.
        // Only when the reserved lab's compound matches: it's a GH2O-only lab
        // (upgrader boost). A defender wanting KHO2 must not be sent here.
        lab = reserved;
      }
    }

    if (!lab) {
      // Search for a stocked lab in the room
      const labs = creep.room
        .find(FIND_MY_STRUCTURES)
        .filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB);

      for (const candidate of labs) {
        if (candidate.mineralType !== compound) continue;
        if ((candidate.store.getUsedCapacity(compound) ?? 0) < LAB_BOOST_MINERAL * partCount)
          continue;
        if ((candidate.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) < LAB_BOOST_ENERGY * partCount)
          continue;
        lab = candidate;
        break;
      }
    }

    if (!lab) {
      // Fail-open: no lab resolved — proceed unboosted
      delete creep.memory.boosts;
      delete creep.memory.boostWaitStart;
      return true;
    }

    // Move to lab if not in range
    if (!creep.pos.inRangeTo(lab, 1)) {
      moveTo(creep, lab, { range: 1, priority: PRIORITY_WORKER });
      return false;
    }

    // In range — attempt boost
    const result = lab.boostCreep(creep);

    if (result === OK) {
      delete creep.memory.boostWaitStart;
      creep.memory.boosts.shift();
      if (creep.memory.boosts.length === 0) {
        delete creep.memory.boosts;
        return true;
      }
      return false;
    }

    if (result === ERR_NOT_ENOUGH_RESOURCES) {
      // Wait only if there's a realistic chance of refill — if neither storage
      // nor terminal holds the compound, no hauler can deliver it; fail-open so
      // the creep doesn't stall permanently when the compound is exhausted empire-wide.
      const room = creep.room;
      const hasSupply =
        (room.storage?.store.getUsedCapacity(compound) ?? 0) > 0 ||
        (room.terminal?.store.getUsedCapacity(compound) ?? 0) > 0;
      if (!hasSupply) {
        delete creep.memory.boosts;
        delete creep.memory.boostWaitStart;
        return true;
      }
      // Supply exists somewhere, but a hauler must still ferry it into the lab —
      // a delivery that can be starved indefinitely (observed live: the storage
      // link drain monopolised every hauler and 2 upgraders idled ~500 ticks at
      // the lab while 1.6k GH2O sat in storage). Bound the wait: after
      // BOOST_WAIT_TIMEOUT ticks parked in range, fail open and work unboosted
      // rather than idling forever. The compound is left for the next attempt.
      if (creep.memory.boostWaitStart === undefined) {
        creep.memory.boostWaitStart = Game.time;
      } else if (Game.time - creep.memory.boostWaitStart >= BOOST_WAIT_TIMEOUT) {
        delete creep.memory.boosts;
        delete creep.memory.boostWaitStart;
        return true;
      }
      return false;
    }

    // Any other error code → fail-open
    delete creep.memory.boosts;
    delete creep.memory.boostWaitStart;
    return true;
  }

  // All entries consumed (loop completed without returning false)
  delete creep.memory.boosts;
  delete creep.memory.boostWaitStart;
  return true;
}
