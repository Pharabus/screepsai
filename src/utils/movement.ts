import { executeMove, executeMoveAvoidCreeps } from './trafficManager';

export interface MoveOpts {
  range?: number;
  priority?: number;
  visualizePathStyle?: { stroke: string };
}

// At REPATH the cached path is discarded and PathFinder reruns with friendly
// creeps at cost 50 (vs the normal 15) so the new path actually routes around
// the cluster. NATIVE is the last resort: hand off to the engine's own moveTo
// in case our PathFinder is wrong about traversability (custom CostMatrix bug,
// stale base matrix, etc.).
const STUCK_REPATH_THRESHOLD = 2;
const STUCK_NATIVE_THRESHOLD = 3;
const stuckTicks = new Map<string, { x: number; y: number; count: number }>();

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
    if (prev.count >= STUCK_NATIVE_THRESHOLD) {
      prev.count = 0;
      creep.moveTo(targetPos, { range, reusePath: 0 });
      return;
    }
    if (prev.count >= STUCK_REPATH_THRESHOLD) {
      executeMoveAvoidCreeps(creep, targetPos, range, opts?.visualizePathStyle?.stroke);
      return;
    }
  } else {
    stuckTicks.set(creep.name, { x: creep.pos.x, y: creep.pos.y, count: 0 });
  }

  executeMove(creep, targetPos, range, opts?.visualizePathStyle?.stroke);
}

export function cleanStuckTracker(): void {
  for (const name of stuckTicks.keys()) {
    if (!Game.creeps[name]) stuckTicks.delete(name);
  }
}
