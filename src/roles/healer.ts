import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const COMBAT_ROLES: CreepRoleName[] = ['defender', 'rangedDefender'];

function findPartner(creep: Creep): Creep | undefined {
  // Re-use cached partner if still alive
  const cached = creep.memory.partnerName ? Game.creeps[creep.memory.partnerName] : undefined;
  if (cached) return cached;

  // Find nearest friendly combat creep
  const combatants = creep.room.find(FIND_MY_CREEPS, {
    filter: (c) => COMBAT_ROLES.includes(c.memory.role as CreepRoleName),
  });
  if (combatants.length === 0) return undefined;

  let nearest: Creep | undefined;
  let minRange = Infinity;
  for (const c of combatants) {
    const range = creep.pos.getRangeTo(c);
    if (range < minRange) {
      minRange = range;
      nearest = c;
    }
  }

  if (nearest) {
    creep.memory.partnerName = nearest.name;
  }
  return nearest;
}

const states: StateMachineDefinition = {
  FOLLOW: {
    run(creep) {
      // Always try to heal the most injured friendly in range 3 first.
      // FIND_MY_CREEPS excludes the healer itself, so check self-heal explicitly.
      const injured = creep.room.find(FIND_MY_CREEPS, {
        filter: (c) => c.hits < c.hitsMax && creep.pos.getRangeTo(c) <= 3,
      });
      if (creep.hits < creep.hitsMax) {
        // Include self as a candidate — may be the most-injured
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
        // Partner is dead — clear and rally
        creep.memory.partnerName = undefined;
        return 'RALLY';
      }

      const range = creep.pos.getRangeTo(partner);
      if (range > 1) {
        moveTo(creep, partner, { range: 1, visualizePathStyle: { stroke: '#00ff88' } });
      }

      return undefined;
    },
  },
  RALLY: {
    run(creep) {
      const partner = findPartner(creep);
      if (partner) return 'FOLLOW';

      markIdle(creep);
      return undefined;
    },
  },
};

export const healer: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'RALLY');
  },
};
