import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'BUILD';

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
  BUILD: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const site = creep.room.find(FIND_CONSTRUCTION_SITES)[0];
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) {
          moveTo(creep, site, { range: 3, priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#33ff33' } });
        }
      } else {
        const controller = creep.room.controller;
        if (controller) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            moveTo(creep, controller, { range: 3, priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#3333ff' } });
          }
        }
      }
      return undefined;
    },
  },
};

export const builder: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
