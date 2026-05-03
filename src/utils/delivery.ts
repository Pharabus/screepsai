import { moveTo } from './movement';
import { PRIORITY_HAULER } from './trafficManager';

export function deliverToSpawnOrExtension(creep: Creep): boolean {
  if (creep.memory.targetId) {
    const cached = Game.getObjectById(creep.memory.targetId as Id<StructureSpawn>);
    if (
      cached &&
      (cached.structureType === STRUCTURE_SPAWN || cached.structureType === STRUCTURE_EXTENSION) &&
      cached.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    ) {
      if (creep.transfer(cached, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        moveTo(creep, cached, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      }
      return true;
    }
    delete creep.memory.targetId;
  }

  const target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (!target) return false;
  creep.memory.targetId = target.id as Id<StructureSpawn>;
  if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, target, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffffff' },
    });
  }
  return true;
}

export function deliverToControllerContainer(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.controllerContainerId) return false;
  const cc = Game.getObjectById(mem.controllerContainerId);
  if (!cc || cc.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
  if (creep.transfer(cc, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, cc, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffffff' },
    });
  }
  return true;
}
