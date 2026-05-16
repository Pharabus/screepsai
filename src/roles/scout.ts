import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { markIdle } from '../utils/idle';

function pickScoutTarget(creep: Creep): string | undefined {
  return findScoutTarget(creep.memory.homeRoom ?? creep.room.name);
}

const SCOUT_MAX_DEPTH = 3;
const SCOUT_STALE_TICKS = 5000;
// Timeout for reaching a target room. At 1 tile/tick a [MOVE]-only scout
// takes ~40t per room; depth-3 needs ~200t plus border-wait padding.
const SCOUT_STUCK_TICKS = 300;

export function findScoutTarget(homeRoom: string): string | undefined {
  const mem = Memory.rooms[homeRoom];
  const alreadyRemote = new Set(mem?.remoteRooms ?? []);

  const visited = new Set<string>([homeRoom]);
  const queue: Array<{ room: string; depth: number }> = [{ room: homeRoom, depth: 0 }];
  const unscouted: string[] = [];
  const stale: string[] = [];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (entry.depth >= SCOUT_MAX_DEPTH) continue;
    const exits = Game.map.describeExits(entry.room);
    if (!exits) continue;

    for (const neighbor of Object.values(exits)) {
      if (visited.has(neighbor) || alreadyRemote.has(neighbor)) continue;
      visited.add(neighbor);

      const rmem = Memory.rooms[neighbor];
      // Never re-scout owned rooms. Ownership rarely changes, and a scout has
      // zero threat-score so its death doesn't increment the neighbor record —
      // without this skip, scouts loop into the same hostile capital forever
      // (observed: 19 deaths in 12h against a single owner). Still expand the
      // BFS frontier so we can reach unscouted rooms past an owned one.
      if (rmem?.scoutedOwner) {
        queue.push({ room: neighbor, depth: entry.depth + 1 });
        continue;
      }
      // Skip rooms that were recently attempted but failed (scout died at border).
      // Give a SCOUT_STALE_TICKS cooldown before retrying.
      const attemptAge =
        rmem?.scoutAttempted !== undefined ? Game.time - rmem.scoutAttempted : Infinity;
      if (!rmem?.scoutedAt) {
        if (attemptAge > SCOUT_STALE_TICKS) unscouted.push(neighbor);
      } else if (Game.time - rmem.scoutedAt > SCOUT_STALE_TICKS) {
        stale.push(neighbor);
      }

      queue.push({ room: neighbor, depth: entry.depth + 1 });
    }
  }

  return unscouted[0] ?? stale[0];
}

function markUnreachable(targetRoom: string): void {
  const rmem = (Memory.rooms[targetRoom] ??= {});
  rmem.scoutedAt = Game.time;
  rmem.scoutedSources = 0;
}

// 1000 energy drops survive ~1000t at base decay (1/1000 per tick rounded up),
// long enough for a hauler to be dispatched. Smaller drops are noise — they
// either get cleared by the local hauler before scout returns, or decay before
// a remote dispatch could collect them.
const LOOT_DROP_THRESHOLD = 1000;

function recordLoot(room: Room, rmem: RoomMemory): void {
  const ruinEntries: NonNullable<RoomMemory['scoutedLoot']>['ruins'] = [];
  for (const ruin of room.find(FIND_RUINS)) {
    const total = ruin.store.getUsedCapacity();
    if (!total) continue;
    ruinEntries.push({
      id: ruin.id,
      x: ruin.pos.x,
      y: ruin.pos.y,
      energy: ruin.store.getUsedCapacity(RESOURCE_ENERGY),
      total,
    });
  }

  const tombstoneEntries: NonNullable<RoomMemory['scoutedLoot']>['tombstones'] = [];
  for (const tomb of room.find(FIND_TOMBSTONES)) {
    const total = tomb.store.getUsedCapacity();
    if (!total) continue;
    tombstoneEntries.push({
      id: tomb.id,
      x: tomb.pos.x,
      y: tomb.pos.y,
      energy: tomb.store.getUsedCapacity(RESOURCE_ENERGY),
      total,
    });
  }

  const dropEntries: NonNullable<RoomMemory['scoutedLoot']>['drops'] = [];
  for (const drop of room.find(FIND_DROPPED_RESOURCES)) {
    if (drop.amount < LOOT_DROP_THRESHOLD) continue;
    dropEntries.push({
      id: drop.id,
      x: drop.pos.x,
      y: drop.pos.y,
      resourceType: drop.resourceType,
      amount: drop.amount,
    });
  }

  if (ruinEntries.length === 0 && tombstoneEntries.length === 0 && dropEntries.length === 0) {
    delete rmem.scoutedLoot;
    return;
  }
  rmem.scoutedLoot = {
    recordedAt: Game.time,
    ...(ruinEntries.length ? { ruins: ruinEntries } : {}),
    ...(tombstoneEntries.length ? { tombstones: tombstoneEntries } : {}),
    ...(dropEntries.length ? { drops: dropEntries } : {}),
  };
}

const states: StateMachineDefinition = {
  SCOUT: {
    run(creep) {
      if (!creep.memory.targetRoom) {
        const target = pickScoutTarget(creep);
        if (!target) {
          // Nothing left to scout. If we're in a foreign room, markIdle does
          // nothing (no my-spawn/storage anchor), and a scout sitting on a
          // border tile gets auto-evicted across the boundary each tick.
          // Head home and recycle there.
          const homeRoom = creep.memory.homeRoom;
          if (homeRoom && creep.room.name !== homeRoom) {
            moveTo(creep, new RoomPosition(25, 25, homeRoom), {
              range: 20,
              priority: PRIORITY_DEFAULT,
            });
            return undefined;
          }
          const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
          if (spawn) {
            if (spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) {
              moveTo(creep, spawn.pos, { range: 1, priority: PRIORITY_DEFAULT });
            }
            return undefined;
          }
          markIdle(creep);
          return undefined;
        }
        creep.memory.targetRoom = target;
        delete creep.memory._scoutTick;
        // Stamp the room so findScoutTarget skips it while this scout is alive.
        // If the scout dies before entering, scoutedAt won't be set but
        // scoutAttempted will, preventing a tight respawn loop.
        (Memory.rooms[target] ??= {}).scoutAttempted = Game.time;
      }

      const targetRoom = creep.memory.targetRoom as string;

      if (creep.room.name === targetRoom) {
        const rmem = (Memory.rooms[targetRoom] ??= {});
        const sources = creep.room.find(FIND_SOURCES);
        rmem.scoutedSources = sources.length;
        rmem.scoutedSourceData = sources.map((s) => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
        rmem.scoutedAt = Game.time;
        delete rmem.scoutAttempted;

        const controller = creep.room.controller;
        rmem.scoutedHasController = !!controller;
        if (controller) {
          rmem.scoutedOwner = controller.owner?.username;
          rmem.scoutedReservation = controller.reservation?.username;
          rmem.scoutedControllerPos = { x: controller.pos.x, y: controller.pos.y };
        }

        const mineral = creep.room.find(FIND_MINERALS)[0];
        if (mineral) {
          rmem.scoutedMineral = {
            type: mineral.mineralType,
            x: mineral.pos.x,
            y: mineral.pos.y,
          };
        }

        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        rmem.scoutedHostiles = hostiles.length;

        recordLoot(creep.room, rmem);

        creep.memory.targetRoom = undefined;
        delete creep.memory._scoutTick;
        return undefined;
      }

      // Path to center of target room — PathFinder handles cross-room routing
      const targetPos = new RoomPosition(25, 25, targetRoom);
      moveTo(creep, targetPos, {
        range: 20,
        priority: PRIORITY_DEFAULT,
        visualizePathStyle: { stroke: '#aaaaaa' },
      });

      // Stuck detection: if we haven't changed rooms after a while, mark unreachable
      if (!creep.memory._scoutTick) {
        creep.memory._scoutTick = Game.time;
      } else if (Game.time - creep.memory._scoutTick > SCOUT_STUCK_TICKS) {
        markUnreachable(targetRoom);
        creep.memory.targetRoom = undefined;
        delete creep.memory._scoutTick;
      }
      return undefined;
    },
  },
};

export const scout: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'SCOUT');
  },
};
