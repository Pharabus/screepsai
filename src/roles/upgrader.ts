import { Role } from './Role';
import { harvestFromBestSource } from '../utils/sources';

/**
 * Upgrader. Camps near the controller and upgrades it.
 *
 * In miner economy (containers exist): withdraws from the controller container
 * or storage, and never self-harvests. Uses heavy WORK body.
 *
 * In bootstrap economy (no containers): self-harvests like before.
 */
export const upgrader: Role = {
  run(creep: Creep): void {
    const mem = Memory.rooms[creep.room.name];
    const minerEconomy = mem?.minerEconomy ?? false;

    if (minerEconomy) {
      runWithLogistics(creep, mem);
    } else {
      runBootstrap(creep);
    }
  },
};

function runBootstrap(creep: Creep): void {
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    harvestFromBestSource(creep);
  } else {
    const controller = creep.room.controller;
    if (controller) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, { range: 3, visualizePathStyle: { stroke: '#3333ff' } });
      }
    }
  }
}

function runWithLogistics(creep: Creep, mem: RoomMemory | undefined): void {
  // Toggle working state
  if (creep.memory.working && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = false;
  }
  if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }

  if (creep.memory.working) {
    const controller = creep.room.controller;
    if (controller) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, { range: 3, visualizePathStyle: { stroke: '#3333ff' } });
      }
    }
  } else {
    // Withdraw from controller container first
    if (mem?.controllerContainerId) {
      const container = Game.getObjectById(mem.controllerContainerId);
      if (container && container.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
        return;
      }
    }
    // Fallback: storage
    const storage = creep.room.storage;
    if (storage && storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(storage, { visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return;
    }
    // Fallback: self-harvest (shouldn't happen often in miner economy)
    harvestFromBestSource(creep);
  }
}
