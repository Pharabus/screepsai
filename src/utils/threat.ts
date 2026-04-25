/**
 * Threat scoring for hostile creeps.
 *
 * Higher = more dangerous. Healers score highest because leaving them alive
 * makes the rest of the squad effectively unkillable by towers. Scouts (no
 * combat parts) score 0 — still worth engaging to deny intel, but lowest
 * priority when a real combatant is present.
 *
 * Dead body parts (hits === 0) are ignored so we don't over-prioritise a
 * creep whose threat parts have already been stripped.
 */

const PART_THREAT: Partial<Record<BodyPartConstant, number>> = {
  [HEAL]: 250,
  [RANGED_ATTACK]: 150,
  [ATTACK]: 80,
  [WORK]: 30, // can dismantle structures
  [CLAIM]: 200, // existential threat to the controller
};

export function threatScore(creep: Creep): number {
  let score = 0;
  for (const part of creep.body) {
    if (part.hits <= 0) continue;
    score += PART_THREAT[part.type] ?? 0;
  }
  return score;
}

/**
 * Pick the single most threatening hostile in the room, for focus-fire.
 * Returns undefined if there are no hostiles.
 */
export function pickPriorityTarget(room: Room): Creep | undefined {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length === 0) return undefined;

  let best: Creep | undefined;
  let bestScore = -Infinity;
  for (const h of hostiles) {
    // Break ties on hits ascending (finish the weak ones) then distance to
    // the first spawn (closer = more dangerous).
    const score = threatScore(h) * 10_000 - h.hits;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}
