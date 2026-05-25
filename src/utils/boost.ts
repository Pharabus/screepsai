import { moveTo } from './movement';
import { PRIORITY_WORKER } from './trafficManager';

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
    if (roomMem?.boostLabId) {
      const reserved = Game.getObjectById(roomMem.boostLabId);
      if (reserved) {
        // Use the reserved lab regardless of stock — a hauler is filling it
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
      creep.memory.boosts.shift();
      if (creep.memory.boosts.length === 0) {
        delete creep.memory.boosts;
        return true;
      }
      return false;
    }

    if (result === ERR_NOT_ENOUGH_RESOURCES) {
      // Wait for the hauler to refill the lab
      return false;
    }

    // Any other error code → fail-open
    delete creep.memory.boosts;
    return true;
  }

  // All entries consumed (loop completed without returning false)
  delete creep.memory.boosts;
  return true;
}
