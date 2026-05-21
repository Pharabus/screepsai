import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { getStructuresByType } from '../utils/tickCache';

const states: StateMachineDefinition = {
  HARVEST: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'DELIVER';

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
    onEnter(creep) {
      delete creep.memory.targetId;
    },
  },
  DELIVER: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'HARVEST';

      const structs = getStructuresByType(creep.room);
      const target = (
        [
          ...(structs[STRUCTURE_SPAWN] ?? []),
          ...(structs[STRUCTURE_EXTENSION] ?? []),
          ...(structs[STRUCTURE_TOWER] ?? []),
        ] as (StructureSpawn | StructureExtension | StructureTower)[]
      ).find((s) => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
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
