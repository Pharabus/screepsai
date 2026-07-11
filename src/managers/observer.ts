import { recordRoomIntel } from '../utils/roomIntel';
import { getMyStructuresByType } from '../utils/tickCache';

// How often the scan queue is rebuilt from RoomMemory.remoteRooms. Mirrors the
// labs reaction-reselect cadence — cheap enough to not need per-tick rebuilds,
// frequent enough to pick up a newly-selected/dropped remote reasonably soon.
const QUEUE_REBUILD_INTERVAL = 500;

/**
 * v1 scope: remote rooms only. Deliberately narrow — this satisfies the
 * original goal ("checking remote room status without sending creeps") at
 * minimal complexity. Neighbor-room monitoring and highway/deposit/power-bank
 * scanning are separate, already-tracked TODOs layered on top later if this
 * proves valuable.
 */
function buildObserverQueue(mem: RoomMemory): string[] {
  return [...new Set(mem.remoteRooms ?? [])].sort();
}

function ensureQueue(mem: RoomMemory): string[] {
  const stale =
    mem.observerQueueBuiltAt === undefined ||
    Game.time - mem.observerQueueBuiltAt >= QUEUE_REBUILD_INTERVAL;
  if (stale || !mem.observerQueue) {
    mem.observerQueue = buildObserverQueue(mem);
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
  // so a room requested last tick is visible now, this tick.
  if (mem.observerRequestedRoom) {
    const observedRoom = Game.rooms[mem.observerRequestedRoom];
    if (observedRoom) recordRoomIntel(observedRoom);
    mem.observerRequestedRoom = undefined;
  }

  // Request: pick the next target and observe it so it's visible next tick.
  const queue = ensureQueue(mem);
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
