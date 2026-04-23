import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  HARVEST: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'DELIVER';
      harvestFromBestSource(creep);
      return undefined;
    },
  },
  DELIVER: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'HARVEST';

      const target = creep.room.find(FIND_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN ||
            s.structureType === STRUCTURE_EXTENSION ||
            s.structureType === STRUCTURE_TOWER) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      })[0];
      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, target, { visualizePathStyle: { stroke: '#ffffff' } });
        }
      } else {
        markIdle(creep);
      }
      return undefined;
    },
  },
};

export const harvester: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'HARVEST');
  },
};
