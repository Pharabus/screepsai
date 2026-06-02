import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';
import { getTransportMission } from '../utils/missions';
import { myStorage } from '../utils/ownership';
import { markIdle } from '../utils/idle';

/**
 * courier — serves a manual cross-room TransportMission: shuttles a resource from
 * the SOURCE room's primary store (storage — owner-agnostic, so a reclaimed room's
 * foreign storage is drained — or terminal) into the DEST room's OWN storage.
 *
 * CreepMemory: homeRoom = dest, targetRoom = source, missionId = transport key.
 *
 * COLLECT → travel to source, withdraw mission.resource (amount-capped so we don't
 *           overshoot the mission's targetAmount). Full, or target met → DELIVER.
 * DELIVER → travel to dest, deposit into myStorage(dest); credit deliveredAmount.
 *
 * When the mission is gone, retiring-and-empty, or the source is exhausted, the
 * courier recycles itself (markIdle) — couriers are not a permanent role.
 */
const states: StateMachineDefinition = {
  COLLECT: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      const mission = creep.memory.missionId
        ? getTransportMission(creep.memory.missionId)
        : undefined;
      if (!mission) {
        markIdle(creep);
        return undefined;
      }
      const resource = mission.resource;
      const carried = creep.store.getUsedCapacity(resource);
      if (creep.store.getFreeCapacity(resource) === 0) return 'DELIVER';

      // Target cap: stop pulling once what's delivered + what we carry meets it.
      const remaining = mission.targetAmount - mission.deliveredAmount - carried;
      if (remaining <= 0) {
        if (carried > 0) return 'DELIVER';
        markIdle(creep);
        return undefined;
      }

      const source = mission.sourceRoom;
      if (creep.room.name !== source) {
        const sroom = Game.rooms[source];
        const pos = sroom?.storage?.pos ?? new RoomPosition(25, 25, source);
        moveTo(creep, pos, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
        return undefined;
      }

      // In the source room — withdraw from the primary bank (storage is
      // owner-agnostic: returns a reclaimed room's foreign storage, which we want
      // to drain), falling back to the terminal.
      const storage = creep.room.storage;
      const terminal = creep.room.terminal;
      const bank =
        storage && storage.store.getUsedCapacity(resource) > 0
          ? storage
          : terminal && terminal.store.getUsedCapacity(resource) > 0
            ? terminal
            : undefined;
      if (!bank) {
        // Source exhausted — deliver whatever we have, else recycle.
        if (carried > 0) return 'DELIVER';
        markIdle(creep);
        return undefined;
      }

      const amount = Math.min(
        creep.store.getFreeCapacity(resource),
        remaining,
        bank.store.getUsedCapacity(resource),
      );
      if (creep.withdraw(bank, resource, amount > 0 ? amount : undefined) === ERR_NOT_IN_RANGE) {
        moveTo(creep, bank, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return undefined;
    },
  },
  DELIVER: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      const mission = creep.memory.missionId
        ? getTransportMission(creep.memory.missionId)
        : undefined;
      const resource = mission?.resource ?? RESOURCE_ENERGY;
      if (creep.store.getUsedCapacity(resource) === 0) {
        // Empty: keep working only if the mission is still active.
        if (!mission || mission.status === 'retiring') {
          markIdle(creep);
          return undefined;
        }
        return 'COLLECT';
      }

      const dest = creep.memory.homeRoom;
      if (!dest) return undefined;
      if (creep.room.name !== dest) {
        const droom = Game.rooms[dest];
        const pos =
          (droom ? myStorage(droom)?.pos : undefined) ??
          droom?.find(FIND_MY_SPAWNS)[0]?.pos ??
          new RoomPosition(25, 25, dest);
        moveTo(creep, pos, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
        return undefined;
      }

      // In the dest room — deposit into OUR storage only (never a foreign one).
      const storage = myStorage(creep.room);
      if (!storage) {
        markIdle(creep);
        return undefined;
      }
      const carried = creep.store.getUsedCapacity(resource);
      const result = creep.transfer(storage, resource);
      if (result === ERR_NOT_IN_RANGE) {
        moveTo(creep, storage, {
          priority: PRIORITY_HAULER,
          visualizePathStyle: { stroke: '#ffffff' },
        });
      } else if (result === OK && mission) {
        // transfer() moves the full carry in one tick (dest storage has ample
        // room), so credit the pre-transfer amount once.
        mission.deliveredAmount += carried;
      }
      return undefined;
    },
  },
};

export const courier: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'COLLECT');
  },
};
