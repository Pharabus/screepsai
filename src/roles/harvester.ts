import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';

export const harvester: Role = {
  run(creep: Creep): void {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      harvestFromBestSource(creep);
    } else {
      const targets = creep.room.find(FIND_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN ||
            s.structureType === STRUCTURE_EXTENSION ||
            s.structureType === STRUCTURE_TOWER) &&
          s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      });
      const target = targets[0];
      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
        }
      }
    }
  },
};
