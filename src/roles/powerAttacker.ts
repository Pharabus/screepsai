import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

function getTarget(creep: Creep): RoomMemory['powerBankTarget'] | undefined {
  const homeRoom = creep.memory.homeRoom;
  if (!homeRoom) return undefined;
  return Memory.rooms[homeRoom]?.powerBankTarget;
}

/**
 * powerAttacker — part of the power-bank squad (see main.ts powerBankSquad()
 * console command). Pure melee ATTACK against a scouted StructurePowerBank;
 * powerHealer keeps it alive, powerHauler scoops the power once it breaks.
 *
 * State machine:
 *   TRAVEL  → reach the target room interior, then hand off to ATTACK
 *   ATTACK  → close to range 1 of the bank and attack every tick
 *   RETREAT → target cleared or bank destroyed — return home and recycle
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const target = getTarget(creep);
      if (!target) return 'RETREAT';

      if (creep.room.name !== target.room) {
        moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ff0000' },
        });
        return undefined;
      }
      // In the right room but on a border tile — step inward first so the
      // engine cannot auto-evict us back out before we reach the bank.
      if (!isInRoomInterior(creep)) {
        moveTo(creep, new RoomPosition(25, 25, creep.room.name), {
          range: 20,
          priority: PRIORITY_WORKER,
        });
        return undefined;
      }
      return 'ATTACK';
    },
  },

  ATTACK: {
    run(creep) {
      const target = getTarget(creep);
      if (!target) return 'RETREAT';
      if (creep.room.name !== target.room) return 'TRAVEL';

      const bank = Game.getObjectById(target.id);
      if (!bank) {
        // A null lookup on a remote object usually just means no vision this
        // tick, not that the bank is gone — mirrors depositMiner's Fix A.
        // Only retreat once we can actually see the room and confirm it's
        // destroyed.
        if (Game.rooms[target.room]) return 'RETREAT';
        return undefined;
      }

      if (creep.pos.getRangeTo(bank) > 1) {
        moveTo(creep, bank, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ff0000' },
        });
        return undefined;
      }
      creep.attack(bank);
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
        moveTo(creep, spawn, { range: 1, priority: PRIORITY_WORKER });
      }
      return undefined;
    },
  },
};

export const powerAttacker: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
