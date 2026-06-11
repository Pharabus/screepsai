import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { FOREIGN_OBSTACLE_TYPES } from '../managers/construction';

// Storage and terminal are excluded: they hold lootable resources that should
// be drained by haulers via the loot path after claiming, not scattered on the
// floor by dismantle(). Everything else in FOREIGN_OBSTACLE_TYPES is fair game.
const DISMANTLER_TARGETS: Set<StructureConstant> = new Set(
  [...FOREIGN_OBSTACLE_TYPES].filter((t) => t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL),
);

/**
 * dismantler — travels to an unowned target room and dismantles blocking
 * obstacle structures (spawn, tower, extension, lab, factory, etc.) before
 * claiming. Excludes storage and terminal — those are drained via the loot
 * path after claiming rather than destroyed.
 *
 * Triggered by Memory.dismantleTarget (set via the dismantleTarget() console
 * command). Auto-detects STRUCTURE_TOWER in the target room. Waits in place
 * while the room still has a foreign controller owner — only dismantles once
 * the room is unowned (RCL 0), which is when Screeps permits dismantling
 * another player's structures.
 *
 * State machine:
 *   TRAVEL   → move to targetRoom and wait inside it
 *   DISMANTLE → clear towers one by one; retire Memory.dismantleTarget when done
 *   RETREAT  → return home spawn for recycling
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep: Creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return 'RETREAT';

      if (creep.room.name === targetRoom) {
        // Safety: if the room is still owned by another player back out immediately
        // to avoid tower fire. dismantleTarget() should only be called after RCL 0.
        const ctrl = creep.room.controller;
        if (ctrl?.owner && !ctrl.my) {
          moveTo(creep, new RoomPosition(25, 25, creep.memory.homeRoom ?? targetRoom), {
            range: 20,
            priority: PRIORITY_WORKER,
          });
          return undefined;
        }
        if (isInRoomInterior(creep)) return 'DISMANTLE';
      }

      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_WORKER,
      });
      return undefined;
    },
  },

  DISMANTLE: {
    run(creep: Creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return 'RETREAT';
      if (creep.room.name !== targetRoom) return 'TRAVEL';

      // Screeps only permits dismantling structures in a room we own or that is
      // fully unowned (RCL 0). Wait here while a foreign controller still holds
      // the room — the tower is confirmed inactive so this is safe.
      const ctrl = creep.room.controller;
      if (ctrl?.owner && !ctrl.my) return undefined;

      const obstacles = creep.room.find(FIND_STRUCTURES, {
        filter: (s) => DISMANTLER_TARGETS.has(s.structureType),
      });

      if (obstacles.length === 0) {
        if (Memory.dismantleTarget?.room === targetRoom) {
          delete Memory.dismantleTarget;
        }
        return 'RETREAT';
      }

      const target = obstacles[0];
      if (!target) return undefined;
      const result = creep.dismantle(target as Structure);
      if (result === ERR_NOT_IN_RANGE) {
        moveTo(creep, target, { range: 1, priority: PRIORITY_WORKER });
      }
      return undefined;
    },
  },

  RETREAT: {
    run(creep: Creep) {
      const homeRoom = creep.memory.homeRoom;
      if (!homeRoom) return undefined;
      const room = Game.rooms[homeRoom];
      const spawn = room?.find(FIND_MY_SPAWNS)[0];
      if (!spawn) return undefined;
      if (creep.pos.getRangeTo(spawn) <= 1) {
        spawn.recycleCreep(creep);
      } else {
        moveTo(creep, spawn, { range: 1, priority: PRIORITY_WORKER });
      }
      return undefined;
    },
  },
};

export const dismantler: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
