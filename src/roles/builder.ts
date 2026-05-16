import { Role } from './Role';
import { gatherEnergy } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const BUILD_PRIORITY: Partial<Record<BuildableStructureConstant, number>> = {
  [STRUCTURE_SPAWN]: 0,
  [STRUCTURE_EXTENSION]: 1,
  [STRUCTURE_TOWER]: 2,
  [STRUCTURE_CONTAINER]: 3,
  [STRUCTURE_STORAGE]: 4,
  [STRUCTURE_ROAD]: 6,
  [STRUCTURE_RAMPART]: 7,
};

const states: StateMachineDefinition = {
  GATHER: {
    run(creep) {
      if (gatherEnergy(creep)) return 'BUILD';
      return undefined;
    },
    onEnter(creep) {
      delete creep.memory.targetId;
    },
  },
  BUILD: {
    run(creep) {
      // Dismantle old-owner structures that block RCL-gated placement — doesn't need energy
      const hostile = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
        filter: (s) =>
          s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER,
      });
      if (hostile) {
        if (creep.dismantle(hostile) === ERR_NOT_IN_RANGE) {
          moveTo(creep, hostile, { range: 1, priority: PRIORITY_WORKER });
        }
        return undefined;
      }

      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'GATHER';

      const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
      sites.sort(
        (a, b) => (BUILD_PRIORITY[a.structureType] ?? 5) - (BUILD_PRIORITY[b.structureType] ?? 5),
      );
      const site = sites[0];
      if (site) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) {
          moveTo(creep, site, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#33ff33' },
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

export const builder: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'GATHER');
  },
};
