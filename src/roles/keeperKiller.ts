import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { getStructuresByType } from '../utils/tickCache';

/**
 * keeperKiller — clears Source Keeper NPCs from SK rooms.
 *
 * Strictly targets creeps owned by 'Source Keeper'. Never engages player creeps
 * or Invaders (hunter handles Invaders).
 *
 * State machine:
 *   TRAVEL  → reach targetRoom interior (≥3 tiles from any border)
 *   PATROL  → circulate between lairs; attack adjacent SKs; self-heal every tick
 *   RETREAT → return to home spawn and recycle when TTL approaches travel time
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return 'RETREAT';
      if (creep.room.name === targetRoom && isInRoomInterior(creep)) return 'PATROL';
      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#ff8800' },
      });
      return undefined;
    },
  },

  PATROL: {
    onEnter(creep) {
      // Cache lair positions on first arrival so subsequent ticks skip the find call.
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return;
      const mem = (Memory.rooms[targetRoom] ??= {});
      if (mem.keeperLairPositions) return;
      const room = Game.rooms[targetRoom];
      if (!room) return;
      const lairs = getStructuresByType(room)[STRUCTURE_KEEPER_LAIR] ?? [];
      mem.keeperLairPositions = lairs.map((l) => ({ x: l.pos.x, y: l.pos.y }));
    },
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom || creep.room.name !== targetRoom) return 'TRAVEL';

      // Retreat when TTL is too low to make it home safely.
      const homeRoom = creep.memory.homeRoom;
      const travelTime =
        (homeRoom ? Memory.rooms[homeRoom]?.remoteDistance?.[targetRoom] : undefined) ?? 100;
      if ((creep.ticksToLive ?? 1500) < travelTime) return 'RETREAT';

      // Self-heal every tick — heal fires alongside attack in the same tick.
      creep.heal(creep);

      // Attack nearest Source Keeper within melee range (1 tile).
      const keepers = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: (c) => c.owner?.username === 'Source Keeper',
      });
      const inRange = keepers.filter((k) => creep.pos.getRangeTo(k) <= 1);
      if (inRange[0]) creep.attack(inRange[0]);

      // Path toward the nearest lair we are not yet adjacent to.
      const lairPositions = Memory.rooms[targetRoom]?.keeperLairPositions;
      if (lairPositions && lairPositions.length > 0) {
        let nearestLair: { x: number; y: number } | undefined;
        let nearestDist = Infinity;
        for (const pos of lairPositions) {
          const dist = creep.pos.getRangeTo(new RoomPosition(pos.x, pos.y, targetRoom));
          if (dist <= 1) continue;
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestLair = pos;
          }
        }
        if (nearestLair) {
          moveTo(creep, new RoomPosition(nearestLair.x, nearestLair.y, targetRoom), {
            range: 1,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#ff8800' },
          });
        }
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

export const keeperKiller: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
