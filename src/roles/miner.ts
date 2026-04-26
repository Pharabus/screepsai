import { Role } from './Role';
import { assignMiner, findUnminedSource } from '../utils/roomPlanner';
import { moveTo } from '../utils/movement';
import { registerStationary, PRIORITY_STATIC, PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

function getSourcePos(creep: Creep): RoomPosition | undefined {
  const roomName = creep.memory.targetRoom ?? creep.room.name;
  const mem = Memory.rooms[roomName];
  const entry = mem?.sources?.find((s) => s.id === creep.memory.targetId);
  if (entry) return new RoomPosition(entry.x, entry.y, roomName);
  return undefined;
}

const states: StateMachineDefinition = {
  POSITION: {
    run(creep) {
      if (!creep.memory.targetId) {
        const roomName = creep.memory.targetRoom ?? creep.room.name;
        const sourceId = findUnminedSource(roomName);
        if (!sourceId) {
          // No source data yet — path to target room to establish visibility
          if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveTo(creep, new RoomPosition(25, 25, creep.memory.targetRoom), {
              range: 20,
              priority: PRIORITY_WORKER,
              visualizePathStyle: { stroke: '#ffaa00' },
            });
          }
          return undefined;
        }
        creep.memory.targetId = sourceId;
        assignMiner(roomName, sourceId, creep.name);
      }

      // Use stored position — works even without visibility
      const sourcePos = getSourcePos(creep);
      if (!sourcePos) {
        creep.memory.targetId = undefined;
        return undefined;
      }

      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);

      // Not in the right room yet — path directly to the source
      if (creep.room.name !== sourcePos.roomName) {
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
        return undefined;
      }

      // In the right room — check for container positioning
      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === creep.memory.targetId);
      const container = entry?.containerId ? Game.getObjectById(entry.containerId) : undefined;

      if (container) {
        if (creep.pos.isEqualTo(container.pos)) return 'HARVEST';
        moveTo(creep, container, {
          range: 0,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      } else if (source) {
        // No container — stand adjacent to source (remote mining or pre-container)
        if (creep.pos.isNearTo(source)) {
          placeRemoteContainer(creep, source);
          return 'HARVEST';
        }
        moveTo(creep, source, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      } else {
        // No visibility — path to stored position
        if (creep.pos.inRangeTo(sourcePos, 1)) return 'HARVEST';
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return undefined;
    },
  },
  HARVEST: {
    run(creep) {
      registerStationary(creep, PRIORITY_STATIC);

      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);
      if (!source) {
        creep.memory.targetId = undefined;
        return 'POSITION';
      }

      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === source.id);

      // Remote miners: build container site, then repair container if damaged
      if (creep.memory.targetRoom && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        const site = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        })[0];
        if (site) {
          creep.build(site);
          return undefined;
        }

        const container = entry?.containerId ? Game.getObjectById(entry.containerId) : undefined;
        if (container && container.hits < container.hitsMax) {
          creep.repair(container);
          return undefined;
        }
      }

      creep.harvest(source);

      if (entry?.linkId && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        const link = Game.getObjectById(entry.linkId);
        if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          creep.transfer(link, RESOURCE_ENERGY);
        }
      }

      // Once a container is built, reposition onto it
      if (creep.memory.targetRoom && entry && !entry.containerId) {
        const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
        })[0];
        if (container) {
          entry.containerId = container.id;
          return 'POSITION';
        }
      }

      return undefined;
    },
  },
};

function placeRemoteContainer(creep: Creep, source: Source): void {
  if (!creep.memory.targetRoom) return;
  const existing = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (existing.length > 0) return;
  const sites = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (sites.length > 0) return;

  creep.room.createConstructionSite(creep.pos, STRUCTURE_CONTAINER);
}

export const miner: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'POSITION');
  },
};
