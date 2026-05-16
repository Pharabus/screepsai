import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';

function getRemoteSourcePos(creep: Creep): RoomPosition | undefined {
  const targetRoom = creep.memory.targetRoom;
  if (!targetRoom) return undefined;
  const mem = Memory.rooms[targetRoom];
  const entry = mem?.sources?.[0];
  if (entry) return new RoomPosition(entry.x, entry.y, targetRoom);
  const scouted = mem?.scoutedSourceData?.[0];
  if (scouted) return new RoomPosition(scouted.x, scouted.y, targetRoom);
  return undefined;
}

const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;

      // Border-safe arrival check — see isInRoomInterior in utils/movement.
      if (creep.room.name === targetRoom && isInRoomInterior(creep)) return 'GATHER';

      const sourcePos = getRemoteSourcePos(creep);
      if (sourcePos) {
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#33ff33' },
        });
      }
      return undefined;
    },
  },
  GATHER: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'BUILD';

      const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer =>
          s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
      });
      if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, container, {
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
      });
      if (dropped) {
        if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
          moveTo(creep, dropped, {
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return 'BUILD';
      return undefined;
    },
  },
  BUILD: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) {
          moveTo(creep, site, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#33ff33' },
          });
        }
        return undefined;
      }

      // No sites left — repair damaged roads instead
      const damaged = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_ROAD && s.hits < s.hitsMax * 0.75,
      });
      if (damaged) {
        if (creep.repair(damaged) === ERR_NOT_IN_RANGE) {
          moveTo(creep, damaged, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ff3333' },
          });
        }
        return undefined;
      }

      // Nothing to do — wait near source
      const sourcePos = getRemoteSourcePos(creep);
      if (sourcePos && !creep.pos.inRangeTo(sourcePos, 3)) {
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#33ff33' },
        });
      }
      return undefined;
    },
  },
};

export const remoteBuilder: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'TRAVEL');
  },
};
