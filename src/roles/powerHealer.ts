import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { markIdle } from '../utils/idle';

const SQUAD_ROLES: CreepRoleName[] = ['powerAttacker', 'powerHauler'];

function getTarget(creep: Creep): RoomMemory['powerBankTarget'] | undefined {
  const homeRoom = creep.memory.homeRoom;
  if (!homeRoom) return undefined;
  return Memory.rooms[homeRoom]?.powerBankTarget;
}

function findPartner(creep: Creep): Creep | undefined {
  const cached = creep.memory.partnerName ? Game.creeps[creep.memory.partnerName] : undefined;
  if (cached && cached.room.name === creep.room.name) return cached;

  const candidates = creep.room.find(FIND_MY_CREEPS, {
    filter: (c) => SQUAD_ROLES.includes(c.memory.role as CreepRoleName),
  });
  let nearest: Creep | undefined;
  let minRange = Infinity;
  for (const c of candidates) {
    const range = creep.pos.getRangeTo(c);
    if (range < minRange) {
      minRange = range;
      nearest = c;
    }
  }
  if (nearest) creep.memory.partnerName = nearest.name;
  return nearest;
}

/**
 * powerHealer — part of the power-bank squad (see main.ts powerBankSquad()
 * console command). Sticks near the squad's powerAttacker(s)/powerHauler(s)
 * in the target room and heals through any incidental damage — the bank
 * itself never attacks (see buildPowerAttackerBody's doc comment), so this
 * is precautionary cover, not a response to a known threat pattern.
 *
 * State machine:
 *   TRAVEL  → reach the target room interior
 *   FOLLOW  → heal the most-injured squadmate in range, stay adjacent to a partner
 *   RETREAT → target cleared — return home and recycle
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const target = getTarget(creep);
      if (!target) return 'RETREAT';

      if (creep.room.name !== target.room) {
        moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
        return undefined;
      }
      if (!isInRoomInterior(creep)) {
        moveTo(creep, new RoomPosition(25, 25, creep.room.name), {
          range: 20,
          priority: PRIORITY_WORKER,
        });
        return undefined;
      }
      return 'FOLLOW';
    },
  },

  FOLLOW: {
    run(creep) {
      const target = getTarget(creep);
      if (!target) return 'RETREAT';
      if (creep.room.name !== target.room) return 'TRAVEL';

      // Always try to heal the most injured squadmate in range 3 first.
      // FIND_MY_CREEPS excludes the healer itself, so check self-heal explicitly.
      const injured = creep.room.find(FIND_MY_CREEPS, {
        filter: (c) => c.hits < c.hitsMax && creep.pos.getRangeTo(c) <= 3,
      });
      if (creep.hits < creep.hitsMax) {
        const selfDamage = creep.hitsMax - creep.hits;
        const mostInjured = injured.reduce<Creep | undefined>((best, c) => {
          const damage = c.hitsMax - c.hits;
          return !best || damage > best.hitsMax - best.hits ? c : best;
        }, undefined);
        const mostInjuredDamage = mostInjured ? mostInjured.hitsMax - mostInjured.hits : 0;
        if (!mostInjured || selfDamage >= mostInjuredDamage) {
          creep.heal(creep);
        } else if (creep.pos.getRangeTo(mostInjured) <= 1) {
          creep.heal(mostInjured);
        } else {
          creep.rangedHeal(mostInjured);
        }
      } else if (injured.length > 0) {
        const most = injured.reduce((a, b) => (a.hits < b.hits ? a : b));
        if (creep.pos.getRangeTo(most) <= 1) {
          creep.heal(most);
        } else {
          creep.rangedHeal(most);
        }
      }

      const partner = findPartner(creep);
      if (!partner) {
        creep.memory.partnerName = undefined;
        // No squadmate here yet — hold near the bank position rather than
        // wandering; one will arrive shortly.
        moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
          range: 3,
          priority: PRIORITY_WORKER,
        });
        return undefined;
      }
      if (creep.pos.getRangeTo(partner) > 1) {
        moveTo(creep, partner, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#00ff88' },
        });
      }
      return undefined;
    },
  },

  RETREAT: {
    run(creep) {
      const homeRoom = creep.memory.homeRoom;
      if (!homeRoom) {
        markIdle(creep);
        return undefined;
      }
      const room = Game.rooms[homeRoom];
      const spawn = room?.find(FIND_MY_SPAWNS)[0];
      if (!spawn) {
        markIdle(creep);
        return undefined;
      }
      if (creep.room.name !== homeRoom || creep.pos.getRangeTo(spawn) > 1) {
        moveTo(creep, spawn, { range: 1, priority: PRIORITY_WORKER });
        return undefined;
      }
      spawn.recycleCreep(creep);
      return undefined;
    },
  },
};

export const powerHealer: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
