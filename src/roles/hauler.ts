import { Role } from './Role';
import { moveTo } from '../utils/movement';

/**
 * Hauler. Carries energy from source containers to structures that need it.
 *
 * Body pattern: [CARRY, CARRY, MOVE, MOVE] — pure logistics, no WORK parts.
 *
 * Delivery priority: spawn > extensions > towers > controller container > storage.
 * Pickup priority: fullest source container > storage (if delivering to controller container).
 */
export const hauler: Role = {
  run(creep: Creep): void {
    // Toggle working state
    if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.working = false;
    }
    if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.working = true;
    }

    if (creep.memory.working) {
      deliver(creep);
    } else {
      pickup(creep);
    }
  },
};

function pickup(creep: Creep): void {
  // Pick up from dropped resources first (miner overflow)
  const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      moveTo(creep, dropped, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
    return;
  }

  // Then withdraw from the fullest source container
  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  // Prefer source containers (exclude the controller container)
  const mem = Memory.rooms[creep.room.name];
  const controllerContainerId = mem?.controllerContainerId;
  const sourceContainers = containers.filter((c) => c.id !== controllerContainerId);
  const target = sourceContainers.sort(
    (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
  )[0];

  if (target) {
    if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, target, { visualizePathStyle: { stroke: '#ffaa00' } });
    }
    return;
  }

  // Fallback: withdraw from storage only if a critical target needs energy
  const storage = creep.room.storage;
  if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    const hasSpawnNeed = creep.room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    }).length > 0;
    const hasTowerNeed = creep.room.find(FIND_MY_STRUCTURES, {
      filter: (s): s is StructureTower =>
        s.structureType === STRUCTURE_TOWER &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
    }).length > 0;

    if (hasSpawnNeed || hasTowerNeed) {
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, { visualizePathStyle: { stroke: '#ffaa00' } });
      }
    }
  }
}

function deliver(creep: Creep): void {
  // Priority 1: Spawn and extensions
  const spawnTarget = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (spawnTarget) {
    if (creep.transfer(spawnTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, spawnTarget, { visualizePathStyle: { stroke: '#ffffff' } });
    }
    return;
  }

  // Priority 2: Towers below 75% capacity
  const tower = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureTower =>
      s.structureType === STRUCTURE_TOWER &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
  });
  if (tower) {
    if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, tower, { visualizePathStyle: { stroke: '#ffffff' } });
    }
    return;
  }

  // Priority 3: Controller container (if it exists and has space)
  const mem = Memory.rooms[creep.room.name];
  if (mem?.controllerContainerId) {
    const controllerContainer = Game.getObjectById(mem.controllerContainerId);
    if (controllerContainer && controllerContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, controllerContainer, { visualizePathStyle: { stroke: '#ffffff' } });
      }
      return;
    }
  }

  // Priority 4: Storage
  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, { visualizePathStyle: { stroke: '#ffffff' } });
    }
    return;
  }
}
