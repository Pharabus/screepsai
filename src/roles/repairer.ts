import { Role } from './Role';
import { gatherEnergy } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { REPAIR_THRESHOLD } from '../utils/thresholds';
import { getStructuresByType } from '../utils/tickCache';

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (gatherEnergy(creep)) return 'REPAIR';
      return undefined;
    },
    onEnter(creep) {
      delete creep.memory.targetId;
    },
  },
  REPAIR: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      // Exclude walls (too expensive) and ramparts (towers handle those) so the
      // spawner's repairersNeeded exclusion list stays consistent.
      const structs = getStructuresByType(creep.room);
      let target: Structure | undefined;
      for (const [type, list] of Object.entries(structs) as [StructureConstant, Structure[]][]) {
        if (type === STRUCTURE_WALL || type === STRUCTURE_RAMPART) continue;
        const damaged = list.find((s) => s.hits < s.hitsMax * REPAIR_THRESHOLD);
        if (damaged) {
          target = damaged;
          break;
        }
      }
      if (target) {
        if (creep.repair(target) === ERR_NOT_IN_RANGE) {
          moveTo(creep, target, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ff3333' },
          });
        }
      } else {
        const controller = creep.room.controller;
        if (controller) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            moveTo(creep, controller, {
              range: 3,
              priority: PRIORITY_WORKER,
              visualizePathStyle: { stroke: '#3333ff' },
            });
          }
        }
      }
      return undefined;
    },
  },
};

export const repairer: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
