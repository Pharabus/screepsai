import { recordRoomIntel, recordHighwayIntel } from '../utils/roomIntel';
import { isHighwayRoom, offsetRoomName } from '../utils/roomName';
import { getMyStructuresByType } from '../utils/tickCache';
import { profile } from '../utils/profiler';

// How often the scan queue is rebuilt from RoomMemory.remoteRooms. Mirrors the
// labs reaction-reselect cadence — cheap enough to not need per-tick rebuilds,
// frequent enough to pick up a newly-selected/dropped remote reasonably soon.
const QUEUE_REBUILD_INTERVAL = 500;

// How far out (Chebyshev distance, in rooms) to look for highway rooms
// around each owned room. A ring-1-only search (just the 4 cardinal
// neighbors) found nothing for any of our current rooms — none of them sit
// close enough to a sector grid line — so this covers rings 1 and 2. Well
// within STRUCTURE_OBSERVER's 10-room observe range, so no reachability
// concern; the cost is a slightly longer scan-queue cycle (see below), not
// CPU (still one room requested per tick regardless of queue length).
const HIGHWAY_SCAN_RADIUS = 2;

/**
 * Highway rooms within `HIGHWAY_SCAN_RADIUS` rooms of this room (Chebyshev
 * distance, excluding the room itself), filtered to the ones sitting on a
 * sector grid line. Computed via coordinate math (`offsetRoomName`) rather
 * than `Game.map.describeExits` — the latter only ever returns the 4
 * immediate neighbors, which can't express a ring wider than 1.
 */
function adjacentHighwayRooms(roomName: string): string[] {
  const found: string[] = [];
  for (let dx = -HIGHWAY_SCAN_RADIUS; dx <= HIGHWAY_SCAN_RADIUS; dx++) {
    for (let dy = -HIGHWAY_SCAN_RADIUS; dy <= HIGHWAY_SCAN_RADIUS; dy++) {
      if (dx === 0 && dy === 0) continue;
      const candidate = offsetRoomName(roomName, dx, dy);
      if (candidate && isHighwayRoom(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * Combines this room's remote-mining rooms with its adjacent highway rooms
 * into one scan queue. Highway rooms have no controller/sources so they're
 * harvested by `recordHighwayIntel` instead of `recordRoomIntel` — see the
 * dispatch in `runRoomObserver` below, which re-checks `isHighwayRoom` at
 * harvest time rather than tagging queue entries, keeping the queue itself a
 * plain string list.
 */
function buildObserverQueue(room: Room, mem: RoomMemory): string[] {
  return [...new Set([...(mem.remoteRooms ?? []), ...adjacentHighwayRooms(room.name)])].sort();
}

function ensureQueue(room: Room, mem: RoomMemory): string[] {
  const stale =
    mem.observerQueueBuiltAt === undefined ||
    Game.time - mem.observerQueueBuiltAt >= QUEUE_REBUILD_INTERVAL;
  if (stale || !mem.observerQueue) {
    mem.observerQueue = buildObserverQueue(room, mem);
    mem.observerQueueBuiltAt = Game.time;
    mem.observerQueueIdx = 0;
  }
  if ((mem.observerQueueIdx ?? 0) >= mem.observerQueue.length) mem.observerQueueIdx = 0;
  return mem.observerQueue;
}

function runRoomObserver(room: Room): void {
  const observer = getMyStructuresByType(room)[STRUCTURE_OBSERVER]?.[0] as
    | StructureObserver
    | undefined;
  if (!observer) return;

  const mem = (Memory.rooms[room.name] ??= {});

  // Harvest: observeRoom() grants vision starting the tick AFTER it's called,
  // so a room requested last tick is visible now, this tick. Profiled
  // separately from the remote-room path (recordRoomIntel, covered by the
  // outer 'observer' wrap in main.ts) so its CPU cost is visible on its own
  // line in stats() rather than folded into the existing average — this is
  // new, previously-unbudgeted work on a highway room's structure/deposit
  // count, which can differ meaningfully from a remote room's.
  if (mem.observerRequestedRoom) {
    const observedRoom = Game.rooms[mem.observerRequestedRoom];
    if (observedRoom) {
      if (isHighwayRoom(observedRoom.name)) {
        profile('observer.highway', () => recordHighwayIntel(observedRoom));
      } else {
        recordRoomIntel(observedRoom);
      }
    }
    mem.observerRequestedRoom = undefined;
  }

  // Request: pick the next target and observe it so it's visible next tick.
  const queue = ensureQueue(room, mem);
  if (queue.length === 0) return;

  const idx = mem.observerQueueIdx ?? 0;
  const target = queue[idx];
  mem.observerQueueIdx = (idx + 1) % queue.length;
  if (!target) return;

  if (observer.observeRoom(target) === OK) {
    mem.observerRequestedRoom = target;
  }
}

/** Runs the per-room observer scan cycle for every owned room with a built Observer. */
export function runObserver(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    runRoomObserver(room);
  }
}
