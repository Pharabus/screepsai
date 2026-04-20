import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';

export const upgrader: Role = {
  run(creep: Creep): void {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      harvestFromBestSource(creep);
    } else {
      const controller = creep.room.controller;
      if (controller) {
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
          creep.moveTo(controller, { visualizePathStyle: { stroke: '#3333ff' } });
        }
      }
    }
  },
};
