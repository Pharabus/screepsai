import { Role } from './Role';
import { gatherEnergy } from '../utils/sources';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { MAX_LABS } from '../managers/construction';
import { LAB_STAMP } from '../utils/layoutPlanner';

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
      // Pass 1: dismantle old-owner structures that block RCL-gated placement — doesn't need energy
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

      // Pass 2: dismantle roads on planned lab stamp tiles — clears blocked lab sites.
      // labPositions only records tiles that passed isTileBuildable at plan time; road-blocked
      // slots are silently dropped, so we must re-walk the raw stamp to find them.
      const plan = Memory.rooms[creep.room.name]?.layoutPlan;
      if (plan?.storagePos) {
        const rcl = creep.room.controller?.level ?? 0;
        const maxLabs = MAX_LABS[rcl] ?? 0;
        const labAx = plan.storagePos.x + 2;
        const labAy = plan.storagePos.y + 2;
        for (const [dx, dy] of LAB_STAMP.slice(0, maxLabs)) {
          const x = labAx + dx;
          const y = labAy + dy;
          const structs = creep.room.lookForAt(LOOK_STRUCTURES, x, y);
          const hasLabOrCS =
            structs.some((s) => s.structureType === STRUCTURE_LAB) ||
            creep.room
              .lookForAt(LOOK_CONSTRUCTION_SITES, x, y)
              .some((s) => s.structureType === STRUCTURE_LAB);
          if (hasLabOrCS) continue;
          const road = structs.find((s) => s.structureType === STRUCTURE_ROAD);
          if (!road) continue;
          if (creep.pos.getRangeTo(road) > 3) continue;
          if (creep.dismantle(road) === ERR_NOT_IN_RANGE) {
            moveTo(creep, road, { range: 1, priority: PRIORITY_WORKER });
          }
          return undefined;
        }
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
        const homeRoomName = creep.memory.homeRoom ?? creep.room.name;
        if (creep.room.name !== homeRoomName) {
          // No sites in this room and it's not home — return rather than upgrading a foreign controller
          moveTo(creep, new RoomPosition(25, 25, homeRoomName), {
            range: 20,
            priority: PRIORITY_WORKER,
          });
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
