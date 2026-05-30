import { Role } from './Role';
import { assignMiner, findOwnedSource, findUnminedSource } from '../utils/roomPlanner';
import { isInRoomInterior, moveTo } from '../utils/movement';
import { registerStationary, PRIORITY_STATIC, PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';

function getSourcePos(creep: Creep): RoomPosition | undefined {
  const roomName = creep.memory.targetRoom ?? creep.room.name;
  const mem = Memory.rooms[roomName];
  const entry = mem?.sources?.find((s) => s.id === creep.memory.targetId);
  if (entry) return new RoomPosition(entry.x, entry.y, roomName);
  return undefined;
}

const states: StateMachineDefinition = {
  POSITION: {
    onEnter(creep) {
      // Traveling miners should be pushable; clear the static priority set by HARVEST.
      delete creep.memory.movePriority;
    },
    run(creep) {
      if (!creep.memory.targetId) {
        const roomName = creep.memory.targetRoom ?? creep.room.name;
        // Fix B: try to reclaim the source this creep is already assigned to
        // (minerName still points at us even though targetId was wiped).
        const ownedId = findOwnedSource(roomName, creep.name);
        const sourceId = ownedId ?? findUnminedSource(roomName);
        if (!sourceId) {
          // No source data yet — path to target room to establish visibility.
          if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            moveTo(creep, new RoomPosition(25, 25, creep.memory.targetRoom), {
              range: 20,
              priority: PRIORITY_WORKER,
              visualizePathStyle: { stroke: '#ffaa00' },
            });
          } else if (creep.memory.targetRoom && !isInRoomInterior(creep)) {
            // Fix C: inside target room but on a border tile — step inward so the
            // engine cannot auto-evict the creep back across the boundary.
            moveTo(creep, new RoomPosition(25, 25, creep.room.name), {
              range: 20,
              priority: PRIORITY_WORKER,
              visualizePathStyle: { stroke: '#ffaa00' },
            });
          }
          return undefined;
        }
        creep.memory.targetId = sourceId;
        assignMiner(roomName, sourceId, creep.name);
      }

      // Use stored position — works even without visibility
      const sourcePos = getSourcePos(creep);
      if (!sourcePos) {
        creep.memory.targetId = undefined;
        return undefined;
      }

      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);

      // Not in the right room yet — path directly to the source
      if (creep.room.name !== sourcePos.roomName) {
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
        return undefined;
      }

      // In the right room — check for container positioning
      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === creep.memory.targetId);
      const container = entry?.containerId ? Game.getObjectById(entry.containerId) : undefined;

      if (container) {
        if (creep.pos.isEqualTo(container.pos)) return 'HARVEST';
        moveTo(creep, container, {
          range: 0,
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      } else if (source) {
        // No container — stand adjacent to source (remote mining or pre-container)
        if (creep.pos.isNearTo(source)) {
          placeRemoteContainer(creep, source);
          return 'HARVEST';
        }
        moveTo(creep, source, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      } else {
        // No visibility — path to stored position
        if (creep.pos.inRangeTo(sourcePos, 1)) return 'HARVEST';
        moveTo(creep, sourcePos, {
          priority: PRIORITY_WORKER,
          visualizePathStyle: { stroke: '#ffaa00' },
        });
      }
      return undefined;
    },
  },
  HARVEST: {
    run(creep) {
      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);
      if (!source) {
        // Fix A: a null lookup for a remote source almost always means the target
        // room isn't visible this tick, not that the source is gone.  Only wipe
        // targetId when the room IS visible and the object is genuinely absent.
        const targetRoomName = creep.memory.targetRoom ?? creep.room.name;
        if (Game.rooms[targetRoomName]) {
          // Room visible — source is truly gone; clear and reacquire.
          creep.memory.targetId = undefined;
        }
        // Either way, return to POSITION so the creep travels back to the
        // source using the stored position (getSourcePos still works).
        return 'POSITION';
      }

      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === source.id);

      // Validate position before locking in as stationary. If we were pushed
      // off the container tile (or the source adjacency) by a creep that ran
      // earlier this tick, return to POSITION to re-path back.
      const container = entry?.containerId ? Game.getObjectById(entry.containerId) : undefined;
      if (container) {
        if (!creep.pos.isEqualTo(container.pos)) return 'POSITION';
      } else if (!creep.pos.isNearTo(source)) {
        return 'POSITION';
      }

      registerStationary(creep, PRIORITY_STATIC);

      // Remote miners: build container site, then repair container if damaged
      if (creep.memory.targetRoom && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        const site = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
          filter: (s) => s.structureType === STRUCTURE_CONTAINER,
        })[0];
        if (site) {
          creep.build(site);
          return undefined;
        }

        if (container && container.hits < container.hitsMax) {
          creep.repair(container);
          return undefined;
        }
      }

      creep.harvest(source);

      if (entry?.linkId && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        const link = Game.getObjectById(entry.linkId);
        if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          creep.transfer(link, RESOURCE_ENERGY);
        }
      }

      // Once a container is built, reposition onto it
      if (creep.memory.targetRoom && entry && !entry.containerId) {
        const built = source.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER,
        })[0];
        if (built) {
          entry.containerId = built.id;
          return 'POSITION';
        }
      }

      return undefined;
    },
  },
};

function placeRemoteContainer(creep: Creep, source: Source): void {
  if (!creep.memory.targetRoom) return;
  const existing = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (existing.length > 0) return;
  const sites = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
    filter: (s) => s.structureType === STRUCTURE_CONTAINER,
  });
  if (sites.length > 0) return;

  creep.room.createConstructionSite(creep.pos, STRUCTURE_CONTAINER);
}

export const miner: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'POSITION');
  },
};
