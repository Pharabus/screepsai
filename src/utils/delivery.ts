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

  const targets = creep.room.find(FIND_MY_STRUCTURES, {
    filter: (s) =>
      (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
      s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
  });
  if (targets.length === 0) return false;

  const claimed = new Set<string>();
  for (const c of Object.values(Game.creeps)) {
    if (c.name === creep.name) continue;
    if (c.memory.role !== 'hauler' && c.memory.role !== 'remoteHauler') continue;
    if (c.memory.state !== 'DELIVER' || !c.memory.targetId) continue;
    claimed.add(c.memory.targetId);
  }

  targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
  const target = targets.find((t) => !claimed.has(t.id)) ?? targets[0]!;
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
