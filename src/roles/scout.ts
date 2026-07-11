import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { markIdle } from '../utils/idle';
import { recordRoomIntel } from '../utils/roomIntel';

function pickScoutTarget(creep: Creep): string | undefined {
  return findScoutTarget(creep.memory.homeRoom ?? creep.room.name);
}

const SCOUT_MAX_DEPTH = 3;
const SCOUT_STALE_TICKS = 5000;
// Rooms flagged scoutUnreachable use this longer cooldown (~4.6 h at 3 t/s)
// so the spawner doesn't waste scouts on routes blocked by enemy rooms.
const SCOUT_BLOCKED_TICKS = 50_000;
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
      // Never scout through (or into) a known Source Keeper room. A scout has
      // no combat or flee capability, and SK rooms are frequently the ONLY
      // route to whatever lies beyond them (observed live: W44N56 is the sole
      // corridor from W44N57 to W44N55 — no alternate path exists). Transit
      // cost inflation in the path callback only steers PathFinder away from
      // an SK room when a cheaper alternative exists; it can't route around a
      // mandatory chokepoint, so a scout ever assigned a target past one is
      // forced straight through Keeper range and dies repeatedly (100+ attack
      // notifications live). Treat a keeper room as a scouting frontier
      // boundary: stop BFS expansion there entirely. Anything only reachable
      // through an SK-room chokepoint stays unscouted until a keeperKiller
      // clears the way or another route opens.
      if (rmem?.scoutedHasKeepers) continue;
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
      } else {
        const threshold = rmem.scoutUnreachable ? SCOUT_BLOCKED_TICKS : SCOUT_STALE_TICKS;
        if (Game.time - rmem.scoutedAt > threshold) stale.push(neighbor);
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
  rmem.scoutUnreachable = true;
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
        recordRoomIntel(creep.room);

        creep.memory.targetRoom = undefined;
        delete creep.memory._scoutTick;
        return undefined;
      }

      // Record ownership for transit rooms. Scouts die in owned rooms before
      // reaching their target, so scoutedOwner never gets set for that room,
      // and the pathfinder keeps routing future scouts through it. Recording
      // here ensures the first death is also the last for any given owned room.
      // Creep code runs before tower fire, so this executes even on the death tick.
      const transitRmem = (Memory.rooms[creep.room.name] ??= {});
      const transitCtrl = creep.room.controller;
      if (transitCtrl?.owner?.username && !transitRmem.scoutedOwner) {
        transitRmem.scoutedOwner = transitCtrl.owner.username;
        transitRmem.scoutedAt = Game.time;
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
