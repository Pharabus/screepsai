import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_HAULER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { deliverToSpawnOrExtension, deliverToControllerContainer } from '../utils/delivery';
import { handleRemoteThreat } from '../utils/remoteThreat';

function pickLootResource(target: Ruin | Tombstone): ResourceConstant | undefined {
  // Only pick up energy — the DELIVER state only transfers energy, so picking up
  // non-energy minerals would leave them permanently stuck in the hauler's store.
  if (target.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return RESOURCE_ENERGY;
  return undefined;
}

function getRemoteSourcePos(creep: Creep): RoomPosition | undefined {
  const targetRoom = creep.memory.targetRoom;
  if (!targetRoom) return undefined;
  const mem = Memory.rooms[targetRoom];
  const entry = mem?.sources?.[0];
  if (entry) return new RoomPosition(entry.x, entry.y, targetRoom);
  // Fall back to scouted data
  const scouted = mem?.scoutedSourceData?.[0];
  if (scouted) return new RoomPosition(scouted.x, scouted.y, targetRoom);
  return undefined;
}

// Mirrors hauler.ts's continueCommittedPickup: once a target is picked, reuse
// Game.getObjectById (an O(1) lookup) instead of re-running the full
// dropped/container/ruin/tombstone find() chain every tick. Without this the
// PICKUP state below re-scanned the entire remote room from scratch on every
// single tick of the pickup phase, even while already walking toward a target
// selected ticks ago — the biggest single driver of role.remoteHauler's CPU
// (avg ~3.5x a regular hauler's, which has had this pattern from the start).
// Energy-only (unlike hauler.ts's version, which also handles minerals) — the
// DELIVER state here only ever transfers RESOURCE_ENERGY.
function continueCommittedPickup(creep: Creep): boolean {
  if (!creep.memory.targetId) return false;

  const target = Game.getObjectById(creep.memory.targetId);
  if (!target) {
    delete creep.memory.targetId;
    return false;
  }

  if ('amount' in target) {
    if (target.resourceType !== RESOURCE_ENERGY || target.amount === 0) {
      delete creep.memory.targetId;
      return false;
    }
    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
      moveTo(creep, target, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  if ('store' in target) {
    if (target.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      delete creep.memory.targetId;
      return false;
    }
    if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      moveTo(creep, target, {
        priority: PRIORITY_HAULER,
        visualizePathStyle: { stroke: '#ffaa00' },
      });
    }
    return true;
  }

  delete creep.memory.targetId;
  return false;
}

const states: StateMachineDefinition = {
  PICKUP: {
    onEnter(creep) {
      delete creep.memory.targetId;
    },
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'DELIVER';

      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;

      if (creep.room.name !== targetRoom) {
        // Path toward the remote source — cross-room PathFinder handles the rest
        const sourcePos = getRemoteSourcePos(creep);
        if (sourcePos) {
          moveTo(creep, sourcePos, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      // Already chasing a target from a previous tick — skip the full
      // dropped/container/ruin/tombstone scan below entirely.
      if (continueCommittedPickup(creep)) return undefined;

      // In the remote room — pick up dropped energy or withdraw from containers
      const dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
      });
      if (dropped) {
        creep.memory.targetId = dropped.id;
        if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
          moveTo(creep, dropped, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer =>
          s.structureType === STRUCTURE_CONTAINER && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
      });
      if (container) {
        creep.memory.targetId = container.id;
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, container, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffaa00' },
          });
        }
        return undefined;
      }

      // Abandoned loot in the remote room — invader ruins, dead-creep tombstones.
      // Lower priority than energy pickup since this is opportunistic, but better
      // than waiting idle when there's no source energy to grab.
      const ruin = creep.pos.findClosestByRange(FIND_RUINS, {
        filter: (r) => r.store.getUsedCapacity() > 0,
      });
      const tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
        filter: (t) => t.store.getUsedCapacity() > 0,
      });
      const lootTarget: Ruin | Tombstone | null =
        ruin && tomb
          ? creep.pos.getRangeTo(ruin) <= creep.pos.getRangeTo(tomb)
            ? ruin
            : tomb
          : (ruin ?? tomb);
      if (lootTarget) {
        const resource = pickLootResource(lootTarget);
        if (resource) {
          // continueCommittedPickup is energy-only (see its header comment), so
          // only a genuinely-energy loot target is safe to commit to — a mixed
          // ruin/tomb whose resource happens to be energy this tick still
          // qualifies since pickLootResource already filters to RESOURCE_ENERGY.
          creep.memory.targetId = lootTarget.id;
          if (creep.withdraw(lootTarget, resource) === ERR_NOT_IN_RANGE) {
            moveTo(creep, lootTarget, {
              priority: PRIORITY_HAULER,
              visualizePathStyle: { stroke: resource === RESOURCE_ENERGY ? '#ffaa00' : '#cc66ff' },
            });
          }
          return undefined;
        }
      }

      // Nothing to pick up — deliver what we have, or wait near the source
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return 'DELIVER';

      // Idle near the source so we're ready when energy drops
      const sourcePos = getRemoteSourcePos(creep);
      if (sourcePos && !creep.pos.inRangeTo(sourcePos, 3)) {
        moveTo(creep, sourcePos, {
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
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'PICKUP';

      const homeRoom = creep.memory.homeRoom;
      if (!homeRoom) return undefined;

      if (creep.room.name !== homeRoom) {
        // Path toward home storage or spawn — cross-room PathFinder handles the rest
        const room = Game.rooms[homeRoom];
        const target = room?.storage?.pos ?? room?.find(FIND_MY_SPAWNS)[0]?.pos;
        if (target) {
          moveTo(creep, target, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffffff' },
          });
        }
        return undefined;
      }

      // In home room — deliver to storage first, then spawn/extensions
      const storage = creep.room.storage;
      if (storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, storage, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffffff' },
          });
        }
        return undefined;
      }

      if (deliverToSpawnOrExtension(creep)) return undefined;

      const tower = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
        filter: (s): s is StructureTower =>
          s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
      });
      if (tower) {
        if (creep.transfer(tower, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          moveTo(creep, tower, {
            priority: PRIORITY_HAULER,
            visualizePathStyle: { stroke: '#ffffff' },
          });
        }
        return undefined;
      }

      if (deliverToControllerContainer(creep)) return undefined;

      return undefined;
    },
  },
};

export const remoteHauler: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'PICKUP');
  },
};
