import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'WORK';

      const mem = Memory.rooms[creep.room.name];
      if (mem?.minerEconomy) {
        if (mem.controllerContainerId) {
          const container = Game.getObjectById(mem.controllerContainerId);
          if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
              moveTo(creep, container, { priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#ffaa00' } });
            }
            return undefined;
          }
        }
        const storage = creep.room.storage;
        if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
          if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            moveTo(creep, storage, { priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#ffaa00' } });
          }
          return undefined;
        }
      }
      harvestFromBestSource(creep);
      return undefined;
    },
  },
  WORK: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const controller = creep.room.controller;
      if (controller) {
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
          moveTo(creep, controller, { range: 3, priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#3333ff' } });
        }
      }
      return undefined;
    },
  },
};

export const upgrader: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
