import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';
import { moveTo } from '../utils/movement';

const REPAIR_THRESHOLD = 0.75;

export const repairer: Role = {
  run(creep: Creep): void {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      harvestFromBestSource(creep);
    } else {
      const target = creep.room.find(FIND_STRUCTURES, {
        filter: (s) => s.hits < s.hitsMax * REPAIR_THRESHOLD && s.structureType !== STRUCTURE_WALL,
      })[0];
      if (target) {
        if (creep.repair(target) === ERR_NOT_IN_RANGE) {
          moveTo(creep, target, { range: 3, visualizePathStyle: { stroke: '#ff3333' } });
        }
      } else {
        const controller = creep.room.controller;
        if (controller) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            moveTo(creep, controller, { range: 3, visualizePathStyle: { stroke: '#3333ff' } });
          }
        }
      }
    }
  },
};
