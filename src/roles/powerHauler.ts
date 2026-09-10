import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { myStorage } from '../utils/ownership';
import { markIdle } from '../utils/idle';

function getTarget(creep: Creep): RoomMemory['powerBankTarget'] | undefined {
  const homeRoom = creep.memory.homeRoom;
  if (!homeRoom) return undefined;
  return Memory.rooms[homeRoom]?.powerBankTarget;
}

/** Clears the home room's powerBankTarget so no further squad members spawn for it. */
function clearTarget(creep: Creep, reason: string): void {
  const homeRoom = creep.memory.homeRoom;
  const mem = homeRoom ? Memory.rooms[homeRoom] : undefined;
  if (!mem?.powerBankTarget) return;
  console.log(
    `[powerHauler] ${creep.name}: power bank squad complete for ${mem.powerBankTarget.room} — ${reason}`,
  );
  delete mem.powerBankTarget;
}

function findPowerDrop(room: Room): Resource<RESOURCE_POWER> | undefined {
  return room.find(FIND_DROPPED_RESOURCES, {
    filter: (r) => r.resourceType === RESOURCE_POWER,
  })[0] as Resource<RESOURCE_POWER> | undefined;
}

/**
 * powerHauler — part of the power-bank squad (see main.ts powerBankSquad()
 * console command). Stages near the bank so it's already in range when it
 * breaks, then scoops the dropped power and runs it home. Makes multiple
 * trips if the bank's power exceeds one load (see buildPowerHaulerBody) —
 * TRAVEL re-enters WAIT/PICKUP after each delivery as long as the target is
 * still set. Owns clearing RoomMemory.powerBankTarget once the whole squad's
 * job is done (bank destroyed AND its power drop fully collected) — mirrors
 * depositMiner's self-clearing abandon().
 *
 * State machine:
 *   TRAVEL  → reach the target room interior
 *   WAIT    → bank not yet broken — stage nearby until a power drop appears
 *   PICKUP  → collect the dropped power
 *   DELIVER → carry it home to storage; loop back to TRAVEL if more remains
 */
const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const target = getTarget(creep);
      if (!target) {
        if (creep.store.getUsedCapacity() > 0) return 'DELIVER';
        markIdle(creep);
        return undefined;
      }

      if (creep.room.name !== target.room) {
        moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffff00' },
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
      return 'WAIT';
    },
  },

  WAIT: {
    run(creep) {
      const target = getTarget(creep);
      if (!target || creep.room.name !== target.room) return 'TRAVEL';

      if (findPowerDrop(creep.room)) return 'PICKUP';

      const bank = Game.getObjectById(target.id);
      if (!bank) {
        // A null lookup on a remote object usually just means no vision —
        // only conclude "nothing left to do" once we can actually see the
        // room (we're standing in it) and confirm both the bank and its
        // drop are gone.
        clearTarget(creep, 'bank destroyed, no power drop found');
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }
      // Stage near the bank so we're already close when it breaks.
      moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
        range: 3,
        priority: PRIORITY_WORKER,
      });
      return undefined;
    },
  },

  PICKUP: {
    run(creep) {
      if (creep.store.getFreeCapacity() === 0) return 'DELIVER';

      const target = getTarget(creep);
      if (!target || creep.room.name !== target.room) return 'DELIVER';

      const drop = findPowerDrop(creep.room);
      if (!drop) {
        // Collected by us or a squadmate in the same tick, or fully decayed.
        clearTarget(creep, 'power drop fully collected');
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }
      if (creep.pos.getRangeTo(drop) > 1) {
        moveTo(creep, drop, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffff00' },
        });
        return undefined;
      }
      creep.pickup(drop);
      return undefined;
    },
  },

  DELIVER: {
    run(creep) {
      if (creep.store.getUsedCapacity() === 0) {
        if (getTarget(creep)) return 'TRAVEL';
        markIdle(creep);
        return undefined;
      }

      const homeRoom = creep.memory.homeRoom;
      if (!homeRoom) {
        markIdle(creep);
        return undefined;
      }
      if (creep.room.name !== homeRoom) {
        const home = Game.rooms[homeRoom];
        const pos = (home ? myStorage(home)?.pos : undefined) ?? new RoomPosition(25, 25, homeRoom);
        moveTo(creep, pos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
        return undefined;
      }

      const storage = myStorage(creep.room);
      if (!storage) {
        markIdle(creep);
        return undefined;
      }
      if (creep.transfer(storage, RESOURCE_POWER) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      }
      return undefined;
    },
  },
};

export const powerHauler: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
