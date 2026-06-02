import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { markIdle } from '../utils/idle';

/**
 * looter — one-shot role that dismantles a foreign-owned structure to drop
 * its store contents as a ground pile for haulers to collect.
 *
 * Spawned by the spawner once per room that has a loot target AND meets the
 * bank-it gate (RCL ≥ 4, own storage present, ≥2 local haulers).  The
 * dropped pile is collected by the room's haulers via pickupLargeDrop.
 *
 * State machine:
 *   TRAVEL   → reach the target room (≥3 tiles from any border)
 *   DISMANTLE → find the loot target from RoomMemory.lootTargetId, dismantle
 *               it tick-by-tick until it reaches 0 hits and disappears; then
 *               clears lootTargetId and idles.
 */

/** Resolve the loot target for the creep's current room. */
export function resolveLootTarget(roomName: string): AnyStoreStructure | null {
  const mem = Memory.rooms[roomName];
  if (!mem) return null;

  // Use the cached ID if it still resolves to a valid structure with resources.
  if (mem.lootTargetId) {
    const existing = Game.getObjectById(mem.lootTargetId);
    if (existing && 'store' in existing) {
      const str = existing as unknown as AnyStoreStructure;
      if ((str.store.getUsedCapacity() ?? 0) > 0) return str;
    }
    // Structure gone or emptied — clear the stale pointer.
    delete mem.lootTargetId;
  }

  return null;
}

const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom ?? creep.memory.homeRoom;
      if (!targetRoom) return undefined;

      // Stay in TRAVEL until 3+ tiles from any border (isInRoomInterior guard),
      // so the engine doesn't auto-evict us back across the exit tile.
      if (creep.room.name === targetRoom && isInRoomInterior(creep)) return 'DISMANTLE';

      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#ff9900' },
      });
      return undefined;
    },
  },

  DISMANTLE: {
    run(creep) {
      // If pushed back across the border, return to TRAVEL.
      const targetRoom = creep.memory.targetRoom ?? creep.memory.homeRoom;
      if (targetRoom && creep.room.name !== targetRoom) return 'TRAVEL';

      const target = resolveLootTarget(creep.room.name);
      if (!target) {
        // Vault is gone — the one-shot job is done. Register idle so idle.ts
        // recycles the creep back to spawn energy rather than letting its all-WORK
        // body sit dead-weight until TTL.
        markIdle(creep);
        return undefined;
      }

      if (creep.dismantle(target as unknown as Structure) === ERR_NOT_IN_RANGE) {
        moveTo(creep, target as unknown as { pos: RoomPosition }, {
          range: 1,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ff9900' },
        });
      }
      return undefined;
    },
  },
};

export const looter: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
