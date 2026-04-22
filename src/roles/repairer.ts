import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const REPAIR_THRESHOLD = 0.75;

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'REPAIR';

      const mem = Memory.rooms[creep.room.name];
      if (mem?.minerEconomy) {
        if (!withdrawFromLogistics(creep)) {
          harvestFromBestSource(creep);
        }
      } else {
        harvestFromBestSource(creep);
      }
      return undefined;
    },
  },
  REPAIR: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const target = creep.room.find(FIND_STRUCTURES, {
        filter: (s) => s.hits < s.hitsMax * REPAIR_THRESHOLD && s.structureType !== STRUCTURE_WALL,
      })[0];
      if (target) {
        if (creep.repair(target) === ERR_NOT_IN_RANGE) {
          moveTo(creep, target, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ff3333' },
          });
        }
      } else {
        const controller = creep.room.controller;
        if (controller) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            moveTo(creep, controller, {
              range: 3,
              priority: PRIORITY_WORKER,
              visualizePathStyle: { stroke: '#3333ff' },
            });
          }
        }
      }
      return undefined;
    },
  },
};

export const repairer: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
