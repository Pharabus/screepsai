import { moveTo } from './movement';
import { PRIORITY_WORKER } from './trafficManager';

/**
 * Max ticks a creep will spend trying to get a single boost applied — the TOTAL
 * budget covering both travel to the lab AND waiting in range for the compound.
 * The timer starts the first tick ensureBoosted processes a pending boost entry
 * (set at the top of the loop) and is cleared on success or fail-open, so each
 * boost entry gets its own fresh budget.
 *
 * Past this it fails open and proceeds unboosted. Two distinct stalls this bounds:
 *  - In-range starvation: the compound sits in storage but a hauler never ferries
 *    it into the lab (e.g. the storage-link drain monopolises every hauler). The
 *    hauler-side preempt (see hauler.ts) makes this rare, but it's still bounded.
 *  - Travel deadlock: the creep cannot physically reach the lab because the lab
 *    cluster is congested (observed live W43N58: an upgrader oscillated for 40+
 *    ticks trying to round the 3×2 lab block from the far side). A fresh upgrader
 *    spawns adjacent to the labs and boosts in ~3 ticks, so the budget is generous
 *    enough that normal operation never trips it — it only catches the pathological
 *    "stuck near labs" case the timer exists to eliminate.
 *
 * An idle creep parked at the labs is strictly worse than an unboosted working one,
 * so failing open is always the right call once the budget is spent.
 */
const BOOST_WAIT_TIMEOUT = 60;

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
/**
 * Total amount of `compound` currently carried by creeps physically in `room`.
 * This is compound "in transit" — e.g. a hauler that has withdrawn GH2O from
 * storage to fill the boost lab but has not yet delivered it. Counting it keeps
 * the boost-reservation gate (upgraderBoostWanted) stable: without it, storage
 * dips below the threshold the instant a hauler grabs the compound, the lab is
 * unreserved mid-fill, and ensureBoosted then finds no lab and fails open — so
 * the lab can never actually be filled (observed live: W43N58 upgraders never
 * boosted because the act of filling the lab tripped the gate reserving it).
 */
export function compoundInTransit(room: Room, compound: ResourceConstant): number {
  let total = 0;
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (!c || c.room?.name !== room.name) continue;
    total += c.store?.getUsedCapacity(compound) ?? 0;
  }
  return total;
}

function bdbg(creep: Creep, msg: string): void {
  if (Memory.boostDebug) {
    console.log(`[boostDebug] ${creep.name} @${Game.time} ${msg}`);
  }
}

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

    // Start the total-attempt budget on the first tick we work this entry. It
    // covers travel to the lab AND any in-range wait for the compound, so a creep
    // can never be permanently stuck near the labs — whether the lab is congested
    // and unreachable or the compound never gets ferried in, it fails open once
    // the budget is spent and works unboosted instead.
    if (creep.memory.boostWaitStart === undefined) {
      creep.memory.boostWaitStart = Game.time;
    } else if (Game.time - creep.memory.boostWaitStart >= BOOST_WAIT_TIMEOUT) {
      bdbg(creep, `FAIL-OPEN timeout (compound=${compound})`);
      delete creep.memory.boosts;
      delete creep.memory.boostWaitStart;
      return true;
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
      bdbg(creep, `FAIL-OPEN no-lab (compound=${compound})`);
      delete creep.memory.boosts;
      delete creep.memory.boostWaitStart;
      return true;
    }

    // Move to lab if not in range
    if (!creep.pos.inRangeTo(lab, 1)) {
      bdbg(creep, `moving to lab ${lab.pos.x},${lab.pos.y} from ${creep.pos.x},${creep.pos.y}`);
      moveTo(creep, lab, { range: 1, priority: PRIORITY_WORKER });
      return false;
    }

    // In range — attempt boost
    const result = lab.boostCreep(creep);
    bdbg(creep, `boostCreep -> ${result} (labGH2O=${lab.store.getUsedCapacity(compound)})`);

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
        bdbg(creep, `FAIL-OPEN no-supply (compound=${compound})`);
        delete creep.memory.boosts;
        delete creep.memory.boostWaitStart;
        return true;
      }
      bdbg(creep, `WAIT for compound (waitStart=${creep.memory.boostWaitStart ?? Game.time})`);
      // Supply exists somewhere, but a hauler must still ferry it into the lab.
      // The total-attempt timeout at the top of the loop bounds this wait, so we
      // just hold here and let it expire if the delivery never lands.
      return false;
    }

    // Any other error code → fail-open
    bdbg(creep, `FAIL-OPEN other-error result=${result}`);
    delete creep.memory.boosts;
    delete creep.memory.boostWaitStart;
    return true;
  }

  // All entries consumed (loop completed without returning false)
  delete creep.memory.boosts;
  delete creep.memory.boostWaitStart;
  return true;
}
