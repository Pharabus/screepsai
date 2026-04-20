/**
 * Find the best energy source for a creep by balancing harvester load.
 * Picks the source with the fewest creeps assigned to it (by proximity).
 */
export function findBestSource(creep: Creep): Source | undefined {
  const sources = creep.room.find(FIND_SOURCES_ACTIVE);
  if (sources.length === 0) return undefined;

  const harvesters = Object.values(Game.creeps).filter(
    (c) => c.room.name === creep.room.name && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  );

  let bestSource: Source | undefined;
  let bestScore = Infinity;

  for (const source of sources) {
    const assigned = harvesters.filter(
      (c) => c.name !== creep.name && source.pos.inRangeTo(c, 2),
    ).length;
    const distance = creep.pos.getRangeTo(source);
    // Favor fewer assigned creeps, break ties by distance
    const score = assigned * 100 + distance;
    if (score < bestScore) {
      bestScore = score;
      bestSource = source;
    }
  }

  return bestSource;
}

export function harvestFromBestSource(creep: Creep): void {
  const source = findBestSource(creep);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
  }
}
