import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  PICKUP: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'DELIVER';
      const found = pickup(creep);
      if (!found && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return 'DELIVER';
      return undefined;
    },
  },
  DELIVER: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'PICKUP';
      deliver(creep);
      return undefined;
    },
  },
};

export const hauler: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'PICKUP');
  },
};

function pickup(creep: Creep): boolean {
  const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      moveTo(creep, dropped, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  const mem = Memory.rooms[creep.room.name];
  if (mem?.storageLinkId) {
    const storageLink = Game.getObjectById(mem.storageLinkId);
    if (storageLink && storageLink.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.withdraw(storageLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storageLink, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return true;
    }
  }

  const containers = creep.room.find(FIND_STRUCTURES, {
    filter: (s): s is StructureContainer =>
      s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  });

  const controllerContainerId = mem?.controllerContainerId;
  const sourceContainers = containers.filter((c) => c.id !== controllerContainerId);
  const target = sourceContainers.sort(
    (a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY),
  )[0];

  if (target) {
    if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, target, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  if (mem?.mineralContainerId) {
    const mineralContainer = Game.getObjectById(mem.mineralContainerId);
    if (
      mineralContainer &&
      mineralContainer.store.getUsedCapacity() >
        mineralContainer.store.getUsedCapacity(RESOURCE_ENERGY)
    ) {
      const mineralTypes = Object.keys(mineralContainer.store) as ResourceConstant[];
      const mineralType = mineralTypes.find(
        (r) => r !== RESOURCE_ENERGY && mineralContainer.store.getUsedCapacity(r) > 0,
      );
      if (mineralType) {
        if (creep.withdraw(mineralContainer, mineralType) === ERR_NOT_IN_RANGE) {
          moveTo(creep, mineralContainer, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#cc66ff' },
          });
        }
        return true;
      }
    }
  }

  const storage = creep.room.storage;
  if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    const hasSpawnNeed =
      creep.room.find(FIND_MY_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      }).length > 0;
    const hasTowerNeed =
      creep.room.find(FIND_MY_STRUCTURES, {
        filter: (s): s is StructureTower =>
          s.structureType === STRUCTURE_TOWER &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
      }).length > 0;
    const hasControllerNeed =
      mem?.controllerContainerId &&
      (() => {
        const cc = Game.getObjectById(mem.controllerContainerId!);
        return cc && cc.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      })();

    if (hasSpawnNeed || hasTowerNeed || hasControllerNeed) {
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return true;
    }
  }

  markIdle(creep);
  return false;
}

function deliver(creep: Creep): void {
  if (creep.store.getUsedCapacity() > creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
    const storage = creep.room.storage;
    if (storage) {
      const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
      const mineralType = resourceTypes.find(
        (r) => r !== RESOURCE_ENERGY && creep.store.getUsedCapacity(r) > 0,
      );
      if (mineralType) {
        if (creep.transfer(storage, mineralType) === ERR_NOT_IN_RANGE) {
          moveTo(creep, storage, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#cc66ff' },
          });
        }
        return;
      }
    }
  }

  const spawnTarget = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (spawnTarget) {
    if (creep.transfer(spawnTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, spawnTarget, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
    }
    return;
  }

  const tower = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureTower =>
      s.structureType === STRUCTURE_TOWER &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) * 0.25,
  });
  if (tower) {
    if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, tower, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
    }
    return;
  }

  const mem = Memory.rooms[creep.room.name];
  if (mem?.controllerContainerId) {
    const controllerContainer = Game.getObjectById(mem.controllerContainerId);
    if (controllerContainer && controllerContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.transfer(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, controllerContainer, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      }
      return;
    }
  }

  const storage = creep.room.storage;
  if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
    }
    return;
  }

  markIdle(creep);
}
