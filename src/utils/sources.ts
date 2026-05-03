import { moveTo } from './movement';

export const STORAGE_ENERGY_FLOOR = 10_000;

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
        (cached as AnyStructure).structureType === STRUCTURE_STORAGE &&
        (cached as StructureStorage).store.getUsedCapacity(RESOURCE_ENERGY) <= STORAGE_ENERGY_FLOOR
      ) {
        delete creep.memory.targetId;
      } else {
        if (
          creep.withdraw(cached as StructureContainer | StructureStorage, RESOURCE_ENERGY) ===
          ERR_NOT_IN_RANGE
        ) {
          moveTo(creep, cached, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
        return true;
      }
    } else {
      delete creep.memory.targetId;
    }
  }

  // Prefer storage when it exists and has energy — it's centrally located
  // and actively fed by links, making it the primary logistics hub.
  const storage = creep.room.storage;
  if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > STORAGE_ENERGY_FLOOR) {
    creep.memory.targetId = storage.id;
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
    return true;
  }

  // Fall back to source containers (pre-link economy or storage depleted)
  const linkedSources = new Set(
    mem?.sources?.filter((s) => s.linkId).map((s) => s.containerId) ?? [],
  );
  const containers = creep.room
    .find(FIND_STRUCTURES, {
      filter: (s): s is StructureContainer =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.id !== controllerContainerId &&
        !linkedSources.has(s.id) &&
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

  return false;
}

/**
 * Find the best energy source for a creep by balancing harvester load.
 * Picks the source with the fewest creeps assigned to it (by proximity).
 */
function findBestSource(creep: Creep): Source | undefined {
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

/**
 * Gather energy from logistics or self-harvest. Returns true when store is full.
 */
export function gatherEnergy(creep: Creep): boolean {
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
  const mem = Memory.rooms[creep.room.name];
  if (mem?.minerEconomy) {
    if (!withdrawFromLogistics(creep)) {
      harvestFromBestSource(creep);
    }
  } else {
    harvestFromBestSource(creep);
  }
  return false;
}

export function harvestFromBestSource(creep: Creep): void {
  const source = findBestSource(creep);
  if (source) {
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
      moveTo(creep, source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
  }
}
