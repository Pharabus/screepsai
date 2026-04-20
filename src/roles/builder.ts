import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';

export const builder: Role = {
  run(creep: Creep): void {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      harvestFromBestSource(creep);
    } else {
      const site = creep.room.find(FIND_CONSTRUCTION_SITES)[0];
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) {
          creep.moveTo(site, { visualizePathStyle: { stroke: '#33ff33' } });
        }
      } else {
        const controller = creep.room.controller;
        if (controller) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#3333ff' } });
          }
        }
      }
    }
  },
};
