import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';
import { myStorage } from '../utils/ownership';
import { markIdle } from '../utils/idle';

/**
 * Cooldown (ticks) above which a deposit is no longer worth waiting on. Each
 * harvest raises Deposit.lastCooldown (the game escalates it as more total
 * resource is extracted), so yield-per-tick-spent keeps shrinking the longer
 * a deposit is worked — past this point the wait costs more than the next
 * harvest is worth relative to the long highway round trip. Read live off
 * the deposit object each tick rather than hardcoding the escalation
 * formula, so this stays correct regardless of exactly how fast it grows.
 */
const DEPOSIT_ABANDON_COOLDOWN = 100;

function getTarget(creep: Creep): RoomMemory['depositTarget'] | undefined {
  const homeRoom = creep.memory.homeRoom;
  if (!homeRoom) return undefined;
  return Memory.rooms[homeRoom]?.depositTarget;
}

/** Clears the home room's depositTarget so no further depositMiners spawn for it. */
function abandon(creep: Creep, reason: string): void {
  const homeRoom = creep.memory.homeRoom;
  const mem = homeRoom ? Memory.rooms[homeRoom] : undefined;
  if (!mem?.depositTarget) return;
  console.log(
    `[depositMiner] ${creep.name}: abandoning deposit target ${mem.depositTarget.depositType} at ${mem.depositTarget.room} — ${reason}`,
  );
  delete mem.depositTarget;
}

const states: StateMachineDefinition = {
  TRAVEL: {
    onEnter(creep) {
      delete creep.memory.movePriority;
    },
    run(creep) {
      const target = getTarget(creep);
      if (!target) {
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }

      if (creep.room.name !== target.room) {
        moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffcc00' },
        });
        return undefined;
      }
      // In the right room but on a border tile — step inward first so the
      // engine cannot auto-evict us back out before we reach the deposit.
      if (!isInRoomInterior(creep)) {
        moveTo(creep, new RoomPosition(25, 25, creep.room.name), {
          range: 20,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffcc00' },
        });
        return undefined;
      }
      if (creep.pos.inRangeTo(new RoomPosition(target.x, target.y, target.room), 1)) {
        return 'HARVEST';
      }
      moveTo(creep, new RoomPosition(target.x, target.y, target.room), {
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#ffcc00' },
      });
      return undefined;
    },
  },
  HARVEST: {
    run(creep) {
      if (creep.store.getFreeCapacity() === 0) return 'DELIVER';

      const target = getTarget(creep);
      if (!target) {
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }

      const deposit = Game.getObjectById(target.id);
      if (!deposit) {
        // A null lookup on a remote object almost always means the room isn't
        // visible this tick, not that the deposit is gone (mirrors miner.ts's
        // Fix A) — only abandon when we can actually see it's absent.
        if (Game.rooms[target.room]) {
          abandon(creep, 'deposit no longer exists');
        }
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }

      if (deposit.lastCooldown > DEPOSIT_ABANDON_COOLDOWN) {
        abandon(creep, `cooldown too high (${deposit.lastCooldown} > ${DEPOSIT_ABANDON_COOLDOWN})`);
        return creep.store.getUsedCapacity() > 0 ? 'DELIVER' : undefined;
      }

      if (deposit.cooldown > 0) return undefined; // waiting out the current cooldown
      creep.harvest(deposit);
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
      // Deposits only ever yield their own single depositType — whatever the
      // creep is carrying is the one resource to hand off.
      const resource = (Object.keys(creep.store) as ResourceConstant[])[0];
      if (!resource) return undefined;
      if (creep.transfer(storage, resource) === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      }
      return undefined;
    },
  },
};

export const depositMiner: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'TRAVEL');
  },
};
