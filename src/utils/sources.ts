import { moveTo } from './movement';

/**
 * Try to withdraw energy from logistics infrastructure (containers/storage).
 * Returns true if a withdrawal target was found, false if caller should self-harvest.
 * Persists target in creep.memory.targetId so the creep commits to one source
 * until full or the target runs dry.
 */
export function withdrawFromLogistics(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  const controllerContainerId = mem?.controllerContainerId;

  if (creep.memory.targetId) {
    const cached = Game.getObjectById(creep.memory.targetId);
    if (
      cached &&
      'store' in cached &&
      (cached as StructureContainer | StructureStorage).store.getUsedCapacity(RESOURCE_ENERGY) > 0
    ) {
      if (
        creep.withdraw(cached as StructureContainer | StructureStorage, RESOURCE_ENERGY) ===
        ERR_NOT_IN_RANGE
      ) {
        moveTo(creep, cached, { visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return true;
    }
    delete creep.memory.targetId;
  }

  const containers = creep.room
    .find(FIND_STRUCTURES, {
      filter: (s): s is StructureContainer =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.id !== controllerContainerId &&
        s.store.getUsedCapacity(RESOURCE_ENERGY) > 100,
    })
    .sort(
      (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
    );

  const container = containers[0];
  if (container) {
    creep.memory.targetId = container.id;
    if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, container, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
    return true;
  }

  const storage = creep.room.storage;
  if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    creep.memory.targetId = storage.id;
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
    return true;
  }

  return false;
}

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
      moveTo(creep, source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
  }
}
