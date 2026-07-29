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
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return;
      // Stamped on every TRAVEL→PATROL transition (resets if pushed back out and
      // re-enters) — evaluateRemoteRoom requires this to be old enough before an
      // SK room scores as viable. See CreepMemory.patrolSince doc for why.
      creep.memory.patrolSince = Game.time;

      // Cache lair positions on first arrival so subsequent ticks skip the find call.
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

      // Backfill for a creep already mid-PATROL when patrolSince was introduced
      // (onEnter only fires on transition, so an already-patrolling creep would
      // otherwise never get stamped and its room would wrongly look un-established).
      if (creep.memory.patrolSince === undefined) creep.memory.patrolSince = Game.time;

      // Retreat when TTL is too low to make it home safely.
      const homeRoom = creep.memory.homeRoom;
      const travelTime =
        (homeRoom ? Memory.rooms[homeRoom]?.remoteDistance?.[targetRoom] : undefined) ?? 100;
      if ((creep.ticksToLive ?? 1500) < travelTime) return 'RETREAT';

      // Self-heal every tick — heal fires alongside attack in the same tick.
      creep.heal(creep);

      // Ranged + melee combat against the nearest Source Keeper. Source Keepers
      // carry their own RANGED_ATTACK parts and kite a pure-melee attacker
      // (observed live: a melee-only keeperKiller took free ranged damage the
      // whole approach and got worn down before ever landing a hit) — see
      // buildKeeperKillerBody for the matching RANGED_ATTACK body parts.
      // Both fire in the same tick when adjacent (different action types),
      // mirroring the hybrid ranged/melee approach already used by hunterBody.
      const keepers = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: (c) => c.owner?.username === 'Source Keeper',
      });
      const nearest = keepers.reduce<Creep | undefined>((closest, k) => {
        if (!closest) return k;
        return creep.pos.getRangeTo(k) < creep.pos.getRangeTo(closest) ? k : closest;
      }, undefined);
      if (nearest) {
        const range = creep.pos.getRangeTo(nearest);
        if (range <= 3) creep.rangedAttack(nearest);
        if (range <= 1) creep.attack(nearest);
      }

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
