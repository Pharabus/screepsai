import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { moveTo } from '../utils/movement';

const REPAIR_THRESHOLD = 0.75;

export const repairer: Role = {
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
