import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { deliverToSpawnOrExtension, deliverToControllerContainer } from '../utils/delivery';
import { cached } from '../utils/tickCache';

const MINERAL_STORAGE_FLOOR = 5000;

const states: StateMachineDefinition = {
  PICKUP: {
    run(creep) {
      if (creep.store.getFreeCapacity() === 0) return 'DELIVER';
      const found = pickup(creep);
      if (!found && creep.store.getUsedCapacity() > 0) return 'DELIVER';
      return undefined;
    },
  },
  DELIVER: {
    run(creep) {
      if (creep.store.getUsedCapacity() === 0) return 'PICKUP';
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

function getUrgentResponder(room: Room): string | undefined {
  return cached(`urgentResponder:${room.name}`, () => {
    const storage = room.storage;
    if (!storage || storage.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return undefined;

    const myStructures = room.find(FIND_MY_STRUCTURES);
    const hasSpawnNeed = myStructures.some(
      (s) =>
        (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    );
    const hasTowerNeed = myStructures.some(
      (s) =>
        s.structureType === STRUCTURE_TOWER &&
        (s as StructureTower).store.getFreeCapacity(RESOURCE_ENERGY) >
          (s as StructureTower).store.getCapacity(RESOURCE_ENERGY) * 0.25,
    );
    if (!hasSpawnNeed && !hasTowerNeed) return undefined;

    let nearest: string | undefined;
    let bestDist = Infinity;
    for (const c of Object.values(Game.creeps)) {
      if (c.room.name !== room.name || c.memory.role !== 'hauler') continue;
      if (c.store.getFreeCapacity() === 0) continue;
      const dist = c.pos.getRangeTo(storage);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = c.name;
      }
    }
    return nearest;
  });
}

function pickup(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];

  // Only the hauler nearest to storage responds to urgent structure energy needs;
  // other haulers continue normal pickup to avoid wasting decaying dropped resources.
  if (getUrgentResponder(creep.room) === creep.name) {
    const storage = creep.room.storage!;
    if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

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

  // Lab input: withdraw needed mineral from storage for input lab
  if (pickupLabInput(creep, mem)) return true;

  // Lab output: collect compounds from output labs
  if (pickupLabOutput(creep, mem)) return true;

  // Terminal: move excess minerals from storage to terminal
  if (pickupForTerminal(creep)) return true;

  markIdle(creep);
  return false;
}

function pickupLabInput(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.activeReaction || !mem.inputLabIds) return false;
  const storage = creep.room.storage;
  if (!storage) return false;

  const { input1, input2 } = mem.activeReaction;
  const lab1 = Game.getObjectById(mem.inputLabIds[0]);
  const lab2 = Game.getObjectById(mem.inputLabIds[1]);

  if (lab1 && (lab1.store.getFreeCapacity(input1) ?? 0) >= LAB_REACTION_AMOUNT) {
    if (storage.store.getUsedCapacity(input1) > 0) {
      if (creep.withdraw(storage, input1) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
      }
      return true;
    }
  }
  if (lab2 && (lab2.store.getFreeCapacity(input2) ?? 0) >= LAB_REACTION_AMOUNT) {
    if (storage.store.getUsedCapacity(input2) > 0) {
      if (creep.withdraw(storage, input2) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
      }
      return true;
    }
  }
  return false;
}

function pickupLabOutput(creep: Creep, mem: RoomMemory | undefined): boolean {
  if (!mem?.labIds || !mem.inputLabIds) return false;
  const inputSet = new Set(mem.inputLabIds as Id<StructureLab>[]);
  for (const labId of mem.labIds) {
    if (inputSet.has(labId)) continue;
    const lab = Game.getObjectById(labId);
    if (!lab) continue;
    const mineralType = lab.mineralType;
    if (!mineralType || lab.store.getUsedCapacity(mineralType) === 0) continue;
    if (creep.withdraw(lab, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, lab, { priority: PRIORITY_HAULER, visualizePathStyle: { stroke: '#00ff88' } });
    }
    return true;
  }
  return false;
}

function pickupForTerminal(creep: Creep): boolean {
  const storage = creep.room.storage;
  const terminal = creep.room.terminal;
  if (!storage || !terminal || terminal.store.getFreeCapacity() < 1000) return false;

  for (const resource of Object.keys(storage.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) continue;
    if (storage.store.getUsedCapacity(resource) > MINERAL_STORAGE_FLOOR) {
      if (creep.withdraw(storage, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#cc66ff' },
        });
      }
      return true;
    }
  }
  return false;
}

function deliver(creep: Creep): void {
  // Non-energy resources: deliver to lab input, terminal, or storage
  if (creep.store.getUsedCapacity() > creep.store.getUsedCapacity(RESOURCE_ENERGY)) {
    if (deliverToLabInput(creep)) return;
    if (deliverToTerminalOrStorage(creep)) return;
  }

  if (deliverToSpawnOrExtension(creep)) return;

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

  if (deliverToControllerContainer(creep)) return;

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

function deliverToLabInput(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.activeReaction || !mem.inputLabIds) return false;
  const { input1, input2 } = mem.activeReaction;

  const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
  for (const resource of resourceTypes) {
    if (resource === RESOURCE_ENERGY) continue;
    if (creep.store.getUsedCapacity(resource) === 0) continue;

    let targetLab: StructureLab | null = null;
    if (resource === input1) {
      targetLab = Game.getObjectById(mem.inputLabIds[0]);
    } else if (resource === input2) {
      targetLab = Game.getObjectById(mem.inputLabIds[1]);
    }

    if (targetLab && (targetLab.store.getFreeCapacity(resource) ?? 0) > 0) {
      if (creep.transfer(targetLab, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, targetLab, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
      }
      return true;
    }
  }
  return false;
}

function deliverToTerminalOrStorage(creep: Creep): boolean {
  const resourceTypes = Object.keys(creep.store) as ResourceConstant[];
  const mineralType = resourceTypes.find(
    (r) => r !== RESOURCE_ENERGY && creep.store.getUsedCapacity(r) > 0,
  );
  if (!mineralType) return false;

  // Prefer terminal for excess minerals
  const terminal = creep.room.terminal;
  if (terminal && terminal.store.getFreeCapacity() > 0) {
    if (creep.transfer(terminal, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, terminal, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }

  const storage = creep.room.storage;
  if (storage) {
    if (creep.transfer(storage, mineralType) === ERR_NOT_IN_RANGE) {
      moveTo(creep, storage, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
    }
    return true;
  }
  return false;
}
