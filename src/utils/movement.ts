import { executeMove, executeMoveAvoidCreeps, invalidateSerialPath } from './trafficManager';

export interface MoveOpts {
  range?: number;
  priority?: number;
  visualizePathStyle?: { stroke: string };
}

// At REPATH the cached path is discarded and PathFinder reruns with friendly
// creeps at cost 50 so the new path actually routes around the cluster.
// A second forced repath replaces the old native-moveTo fallback — keeping all
// movement inside our traffic system and avoiding the engine's inferior pathfinder.
const STUCK_REPATH_THRESHOLD = 2;
const STUCK_FORCE_THRESHOLD = 3;
const stuckTicks = new Map<string, { x: number; y: number; count: number; cycles: number }>();

export function moveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveOpts,
): void {
  const targetPos = 'pos' in target ? target.pos : target;
  const range = opts?.range ?? 1;

  const prev = stuckTicks.get(creep.name);
  if (prev && prev.x === creep.pos.x && prev.y === creep.pos.y) {
    prev.count++;
    if (prev.count >= STUCK_FORCE_THRESHOLD) {
      // Force a fresh repath and reset the per-cycle counter.
      prev.count = 0;
      prev.cycles++;
      invalidateSerialPath(creep.name);
      // Escalate avoidance cost on repeated failures: a creep stuck through
      // 3+ full cycles (≥9 ticks) has a detour that costs more than 50 — bump
      // to 200 so PathFinder is forced to find genuine alternatives. Caps at
      // 200 to avoid treating every friendly as a wall permanently.
      const avoidCost = prev.cycles >= 3 ? 200 : 50;
      executeMoveAvoidCreeps(creep, targetPos, range, opts?.visualizePathStyle?.stroke, avoidCost);
      return;
    }
    if (prev.count >= STUCK_REPATH_THRESHOLD) {
      executeMoveAvoidCreeps(creep, targetPos, range, opts?.visualizePathStyle?.stroke);
      return;
    }
  } else {
    // Position changed or first call — reset both count and cycle counter.
    stuckTicks.set(creep.name, { x: creep.pos.x, y: creep.pos.y, count: 0, cycles: 0 });
  }

  executeMove(creep, targetPos, range, opts?.visualizePathStyle?.stroke);
}

export function cleanStuckTracker(): void {
  for (const name of stuckTicks.keys()) {
    if (!Game.creeps[name]) stuckTicks.delete(name);
  }
}

// "Arrived" check that excludes the 2-tile border ring. A creep at (37, 0) is
// technically in the room but the engine treats it as an exit tile: if it
// ends a tick on a border tile without moving inward, it gets auto-evicted
// to the adjacent room next tick. Using this check in TRAVEL states keeps
// the creep moving toward (25,25) until it's safely off the border, so the
// work state never starts on a tile that's about to be evicted.
export function isInRoomInterior(creep: Creep): boolean {
  return creep.pos.x > 2 && creep.pos.x < 47 && creep.pos.y > 2 && creep.pos.y < 47;
}
