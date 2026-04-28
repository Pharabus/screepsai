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

function towerEffectiveness(range: number): number {
  if (range <= 5) return 1;
  if (range >= 20) return 0.25;
  return 1 - (0.75 * (range - 5)) / 15;
}

/**
 * Pick the single most threatening hostile in the room, for focus-fire.
 * Returns undefined if there are no hostiles.
 */
export function pickPriorityTarget(room: Room): Creep | undefined {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  if (hostiles.length === 0) return undefined;

  const towers = room.find(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureTower => s.structureType === STRUCTURE_TOWER,
  });

  let best: Creep | undefined;
  let bestScore = -Infinity;
  for (const h of hostiles) {
    let effectiveness = 1;
    if (towers.length > 0) {
      const avgRange = towers.reduce((sum, t) => sum + t.pos.getRangeTo(h), 0) / towers.length;
      effectiveness = towerEffectiveness(avgRange);
    }
    const score = threatScore(h) * 10_000 + effectiveness * 1_000 - h.hits;
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}
