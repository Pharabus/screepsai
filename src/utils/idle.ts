import { moveTo } from './movement';
import { PRIORITY_DEFAULT } from './trafficManager';

const idleCreeps = new Set<string>();

// How many consecutive idle ticks before a role is recycled back to spawn energy.
const RECYCLE_THRESHOLDS: Partial<Record<CreepRoleName, number>> = {
  defender: 100,
  rangedDefender: 100,
  healer: 100,
};

const COMBAT_ROLES = new Set<CreepRoleName>(['defender', 'rangedDefender', 'healer']);

// Tile offsets from the rally center — 2-tile spacing so creeps don't crowd.
const SPREAD_OFFSETS: [number, number][] = [
  [0, 0],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [2, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
];

export function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Parking zone: controller position when it's far from the spawn cluster.
// Keeps idle creeps out of the extension/lab/spawn traffic in the base core.
function getRallyPos(room: Room): { x: number; y: number } | undefined {
  const ctrl = room.controller;
  if (!ctrl?.pos) return undefined;
  const spawn = (room.find(FIND_MY_SPAWNS) as { pos: RoomPosition }[])[0];
  if (!spawn?.pos) return undefined;
  if (ctrl.pos.getRangeTo(spawn.pos) < 8) return undefined;
  return { x: ctrl.pos.x, y: ctrl.pos.y };
}

export function shouldRecycle(creep: Creep, idleTicks: number): boolean {
  const threshold = RECYCLE_THRESHOLDS[creep.memory.role];
  if (!threshold || idleTicks < threshold) return false;
  if (COMBAT_ROLES.has(creep.memory.role)) {
    // Keep combat roles alive if a threat was seen within the last 200 ticks.
    const mem = Memory.rooms[creep.room.name];
    const threatAge = mem?.threatLastSeen !== undefined ? Game.time - mem.threatLastSeen : Infinity;
    if (threatAge < 200) return false;
  }
  return true;
}

export function markIdle(creep: Creep): void {
  idleCreeps.add(creep.name);

  // Track consecutive idle ticks. A gap of >1 tick means the creep did work —
  // reset the streak so idle-time doesn't accumulate across separate idle periods.
  if ((creep.memory._idleLastTick ?? -2) < Game.time - 1) {
    creep.memory.idleSince = Game.time;
  }
  creep.memory._idleLastTick = Game.time;
  const idleTicks = Game.time - (creep.memory.idleSince ?? Game.time);

  // Recycle long-idle creeps — move to spawn and call recycleCreep when adjacent.
  if (shouldRecycle(creep, idleTicks)) {
    const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (spawn) {
      if (spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) {
        moveTo(creep, spawn, { range: 1, priority: PRIORITY_DEFAULT });
      }
      return;
    }
  }

  // Park at the controller area — typically far from the spawn/extension cluster.
  // Each creep gets a deterministic tile offset so they spread out instead of piling.
  const rally = getRallyPos(creep.room);
  if (rally) {
    const [dx, dy] = SPREAD_OFFSETS[nameHash(creep.name) % SPREAD_OFFSETS.length]!;
    const x = Math.max(2, Math.min(47, rally.x + dx));
    const y = Math.max(2, Math.min(47, rally.y + dy));
    const target = new RoomPosition(x, y, creep.room.name);
    if (!creep.pos.isEqualTo(target)) {
      moveTo(creep, target, {
        range: 0,
        priority: PRIORITY_DEFAULT,
        visualizePathStyle: { stroke: '#888888' },
      });
    }
    return;
  }

  // Fallback (controller too close to spawn or no spawn yet): park away from the
  // spawn/extension/storage cluster. Prefer a position near the nearest source
  // container so idle creeps clear spawn-to-source corridors. Fall back to
  // range 8 from storage or spawn when no source positions are available.
  const roomMem = Memory.rooms[creep.room.name];
  const sources = roomMem?.sources;
  if (sources && sources.length > 0) {
    // Pick the closest source position and park at range 6 from it.
    let bestSource: { x: number; y: number } | undefined;
    let bestDist = Infinity;
    for (const s of sources) {
      const dist = Math.max(Math.abs(creep.pos.x - s.x), Math.abs(creep.pos.y - s.y));
      if (dist < bestDist) {
        bestDist = dist;
        bestSource = s;
      }
    }
    if (bestSource) {
      const [dx, dy] = SPREAD_OFFSETS[nameHash(creep.name) % SPREAD_OFFSETS.length]!;
      const x = Math.max(2, Math.min(47, bestSource.x + dx));
      const y = Math.max(2, Math.min(47, bestSource.y + dy));
      const target = new RoomPosition(x, y, creep.room.name);
      if (!creep.pos.isEqualTo(target)) {
        moveTo(creep, target, {
          range: 6,
          priority: PRIORITY_DEFAULT,
          visualizePathStyle: { stroke: '#888888' },
        });
      }
      return;
    }
  }

  const anchor =
    creep.room.storage ?? (creep.room.find(FIND_MY_SPAWNS) as { pos: RoomPosition }[])[0];
  if (anchor && !creep.pos.inRangeTo(anchor, 8)) {
    moveTo(creep, anchor, {
      range: 8,
      priority: PRIORITY_DEFAULT,
      visualizePathStyle: { stroke: '#888888' },
    });
  }
}

export function drawIdleIndicators(): void {
  for (const name of idleCreeps) {
    const creep = Game.creeps[name];
    if (!creep) continue;
    new RoomVisual(creep.room.name).circle(creep.pos, {
      radius: 0.4,
      fill: 'transparent',
      stroke: '#888888',
      strokeWidth: 0.1,
      opacity: 0.6,
    });
  }
}

export function resetIdle(): void {
  idleCreeps.clear();
}
