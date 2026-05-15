import { moveTo } from './movement';
import { PRIORITY_HAULER } from './trafficManager';

export function deliverToSpawnOrExtension(creep: Creep): boolean {
  type FillTarget = StructureSpawn | StructureExtension;
  const isSpawnOrExt = (s: AnyStructure): s is FillTarget =>
    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
    s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;

  // Fill any adjacent empty extension/spawn opportunistically — avoids
  // ignoring reachable targets while pathing toward an unreachable cached one
  const adjacent = creep.pos.findInRange(FIND_MY_STRUCTURES, 1).filter(isSpawnOrExt);
  if (adjacent.length > 0) {
    creep.transfer(adjacent[0]!, RESOURCE_ENERGY);
    if (
      creep.store.getUsedCapacity(RESOURCE_ENERGY) <=
      adjacent[0]!.store.getFreeCapacity(RESOURCE_ENERGY)
    ) {
      delete creep.memory.targetId;
      return true;
    }
    // Energy left and more adjacents still need filling. Stay put: next tick's
    // Phase A drains the next adjacent for free. Pathing to a cached far
    // target now would skip past these reachable refills.
    if (adjacent.length > 1) {
      delete creep.memory.targetId;
      return true;
    }
  }

  // Move toward cached target if still valid and not already adjacent
  if (creep.memory.targetId) {
    const cached = Game.getObjectById(creep.memory.targetId as Id<StructureSpawn>);
    if (cached && isSpawnOrExt(cached) && !creep.pos.isNearTo(cached)) {
      moveTo(creep, cached, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffffff' },
      });
      return true;
    }
    delete creep.memory.targetId;
  }

  // Pick a new movement target — skip adjacent (handled above), prefer unclaimed
  const targets = creep.room
    .find(FIND_MY_STRUCTURES)
    .filter((s): s is FillTarget => isSpawnOrExt(s) && !creep.pos.isNearTo(s));
  if (targets.length === 0) return adjacent.length > 0;

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
  moveTo(creep, target, {
    priority: PRIORITY_HAULER,
    visualizePathStyle: { stroke: '#ffffff' },
  });
  return true;
}

export function deliverToControllerContainer(creep: Creep): boolean {
  const mem = Memory.rooms[creep.room.name];
  if (!mem?.controllerContainerId) return false;
  const cc = Game.getObjectById(mem.controllerContainerId);
  const CONTROLLER_CONTAINER_MIN_FREE = 200;
  if (!cc || cc.store.getFreeCapacity(RESOURCE_ENERGY) < CONTROLLER_CONTAINER_MIN_FREE)
    return false;
  if (creep.transfer(cc, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
    moveTo(creep, cc, {
      priority: PRIORITY_HAULER,
      visualizePathStyle: { stroke: '#ffffff' },
    });
  }
  return true;
}
