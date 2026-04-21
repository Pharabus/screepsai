import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { moveTo } from '../utils/movement';

export const builder: Role = {
  run(creep: Creep): void {
    const mem = Memory.rooms[creep.room.name];
    if (mem?.minerEconomy) {
      runWithLogistics(creep);
    } else {
      runBootstrap(creep);
    }
  },
};

function runBootstrap(creep: Creep): void {
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    harvestFromBestSource(creep);
  } else {
    doWork(creep);
  }
}

function runWithLogistics(creep: Creep): void {
  if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = false;
  }
  if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }

  if (creep.memory.working) {
    doWork(creep);
  } else {
    if (!withdrawFromLogistics(creep)) {
      harvestFromBestSource(creep);
    }
  }
}

function doWork(creep: Creep): void {
  const site = creep.room.find(FIND_CONSTRUCTION_SITES)[0];
  if (site) {
    if (creep.build(site) === ERR_NOT_IN_RANGE) {
      moveTo(creep, site, { range: 3, visualizePathStyle: { stroke: '#33ff33' } });
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
