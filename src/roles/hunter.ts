import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

/**
 * hunter — clears NPC Invader creeps from remote and transit rooms.
 *
 * Spawned by the home colony when an Invader is detected in a remoteRoom or
 * in a transit room on the path to a colony under construction. Strictly
 * targets creeps owned by 'Invader'; never engages player creeps.
 *
 * State machine:
 *   TRAVEL  → reach targetRoom (3+ tiles from border)
 *   HUNT    → attack lowest-HP invader; self-heal while engaged; retreat when clear
 *   RETREAT → return to home spawn for recycling
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return 'RETREAT';
      if (creep.room.name === targetRoom && isInRoomInterior(creep)) return 'HUNT';
      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#ff0000' },
      });
      return undefined;
    },
  },

  HUNT: {
    run(creep) {
      if (creep.room.name !== creep.memory.targetRoom) return 'TRAVEL';

      const invaders = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: (c) => c.owner?.username === 'Invader',
      });

      const mem = (Memory.rooms[creep.room.name] ??= {});

      // Always heal self when damaged — attack and heal can both fire in the same tick.
      if (creep.hits < creep.hitsMax) creep.heal(creep);

      if (invaders.length === 0) {
        // Visibility confirms room clear — signal the spawner to stand down.
        delete mem.invaderSeenAt;
        return 'RETREAT';
      }

      mem.invaderSeenAt = Game.time;

      // Target lowest-HP invader to finish off weakened ones first.
      const target = invaders.reduce((a, b) => (a.hits < b.hits ? a : b));
      if (creep.attack(target) === ERR_NOT_IN_RANGE) {
        moveTo(creep, target, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ff0000' },
        });
      }
      return undefined;
    },
  },

  RETREAT: {
    run(creep) {
      const homeRoom = creep.memory.homeRoom;
      if (!homeRoom) return undefined;

      const room = Game.rooms[homeRoom];
      const spawn = room?.find(FIND_MY_SPAWNS)[0];
      if (!spawn) return undefined;

      if (creep.pos.getRangeTo(spawn) <= 1) {
        spawn.recycleCreep(creep);
      } else {
        moveTo(creep, spawn, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      }
      return undefined;
    },
  },
};

export const hunter: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
