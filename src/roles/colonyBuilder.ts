import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';

/**
 * colonyBuilder — bootstraps a newly-claimed room before it has its own spawn.
 *
 * Travels from the home room to the target colony, harvests directly from the
 * target room's sources (no containers exist yet), and builds construction
 * sites — primarily the first spawn. Once the spawn is up, the colony switches
 * to its own bootstrap economy and this role retires (spawner stops queuing).
 *
 * State machine:
 *   TRAVEL  → reach target room
 *   HARVEST → self-harvest energy (or pick up dropped piles)
 *   BUILD   → build sites; falls back to upgrading the controller (so the
 *             stored energy isn't wasted while waiting for the spawn site to land)
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;
      if (creep.room.name === targetRoom) return 'HARVEST';

      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#33ff33' },
      });
      return undefined;
    },
  },
  HARVEST: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'BUILD';

      // Prefer dropped piles (free energy from passing remote miners or our own decay)
      const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
      });
      if (dropped) {
        if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
          moveTo(creep, dropped, {
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      // Withdraw from any container with energy (claimed room may inherit one from prior owner)
      const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer =>
          s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 50,
      });
      if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, container, {
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      // Fall back to active source — claimer/colonyBuilder need WORK parts; bodies
      // include them precisely for this bootstrap window.
      const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (source) {
        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
          moveTo(creep, source, {
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
      }
      return undefined;
    },
  },
  BUILD: {
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'HARVEST';

      // Priority 1: the first spawn site (and any other spawns under construction)
      const spawnSite = creep.room
        .find(FIND_MY_CONSTRUCTION_SITES)
        .find((s) => s.structureType === STRUCTURE_SPAWN);
      if (spawnSite) {
        if (creep.build(spawnSite) === ERR_NOT_IN_RANGE) {
          moveTo(creep, spawnSite, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#33ff33' },
          });
        }
        return undefined;
      }

      // Priority 2: any other site (extensions, containers placed for the colony)
      const otherSite = creep.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES);
      if (otherSite) {
        if (creep.build(otherSite) === ERR_NOT_IN_RANGE) {
          moveTo(creep, otherSite, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#33ff33' },
          });
        }
        return undefined;
      }

      // Nothing to build — upgrade the controller. Keeps the carried energy
      // productive and accelerates RCL2 (which unlocks 5 extensions).
      const controller = creep.room.controller;
      if (controller?.my) {
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
          moveTo(creep, controller, {
            range: 3,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#9999ff' },
          });
        }
      }
      return undefined;
    },
  },
};

export const colonyBuilder: Role = {
  run(creep: Creep): void {
    // Honour remote threat detection — if hostiles are in the colony, retreat home.
    // The home room then re-queues once the room clears.
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'TRAVEL');
  },
};
