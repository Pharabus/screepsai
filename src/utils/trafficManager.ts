import { cached } from './tickCache';
import { getMyUsername } from './identity';

export const PRIORITY_STATIC = 100;
export const PRIORITY_HAULER = 50;
export const PRIORITY_WORKER = 30;
export const PRIORITY_DEFAULT = 10;

// Tracks which blocker creeps have already been nudged this tick so we don't
// double-push a creep that was already moved.
const pushedThisTick = new Set<string>();

interface PathVis {
  roomName: string;
  points: RoomPosition[];
  stroke: string;
}

const stationaryCreeps = new Set<string>();
let vizBuffer: PathVis[] = [];

// Cross-tick path cache — prevents PathFinder from running every tick and
// eliminates route-flipping when multiple equal-cost paths exist (common in
// crowded rooms without roads). Invalidated by stuck repaths and native moveTo.
interface SerialPath {
  path: RoomPosition[];
  targetKey: string;
  builtAt: number;
}
const pathSerialCache = new Map<string, SerialPath>();
const PATH_SERIAL_TTL = 50;

export function cleanPathSerialCache(): void {
  for (const name of pathSerialCache.keys()) {
    if (!Game.creeps[name]) pathSerialCache.delete(name);
  }
}

export function invalidateSerialPath(creepName: string): void {
  pathSerialCache.delete(creepName);
}

export function registerStationary(creep: Creep, _priority: number): void {
  stationaryCreeps.add(creep.name);
}

export function resetTraffic(): void {
  stationaryCreeps.clear();
  vizBuffer = [];
  pushedThisTick.clear();
}

export function resolveTraffic(): void {
  if (!Memory.visuals || vizBuffer.length === 0) return;
  for (const viz of vizBuffer) {
    new RoomVisual(viz.roomName).poly(viz.points, {
      stroke: viz.stroke,
      lineStyle: 'dashed',
      strokeWidth: 0.15,
      opacity: 0.4,
    });
  }
}

// Nudge a non-stationary friendly creep off the tile our creep wants to step
// onto. Only fires once per blocker per tick (pushedThisTick guard). Picks
// any adjacent tile whose cost matrix value is < 255. Best-effort: if no free
// neighbour exists the push is silently skipped.
function pushBlocker(mover: Creep, nextPos: RoomPosition): void {
  if (nextPos.roomName !== mover.room.name) return;
  const blockers = mover.room.lookForAt(LOOK_CREEPS, nextPos.x, nextPos.y);
  for (const blocker of blockers) {
    if (
      blocker.name === mover.name ||
      !blocker.my ||
      stationaryCreeps.has(blocker.name) ||
      pushedThisTick.has(blocker.name)
    )
      continue;
    if (
      (blocker.memory.movePriority ?? PRIORITY_DEFAULT) >
      (mover.memory.movePriority ?? PRIORITY_DEFAULT)
    )
      continue;
    // Find a free adjacent tile to push the blocker toward.
    const costs = getRoomCostMatrix(blocker.room);
    const dirs: DirectionConstant[] = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const dir of dirs) {
      const nx = blocker.pos.x + (DX[dir] ?? 0);
      const ny = blocker.pos.y + (DY[dir] ?? 0);
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      if (costs.get(nx, ny) >= 255) continue;
      blocker.move(dir);
      pushedThisTick.add(blocker.name);
      break;
    }
  }
}

// Chebyshev direction offsets indexed by DirectionConstant (1–8).
const DX: Record<number, number> = { 1: 0, 2: 1, 3: 1, 4: 1, 5: 0, 6: -1, 7: -1, 8: -1 };
const DY: Record<number, number> = { 1: -1, 2: -1, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: -1 };

export function executeMove(
  creep: Creep,
  target: RoomPosition,
  range: number,
  stroke?: string,
): void {
  if (creep.pos.inRangeTo(target, range)) return;

  const path = getPath(creep, target, range);
  const nextPos = path[0];
  if (!nextPos) return;

  pushBlocker(creep, nextPos);
  creep.move(creep.pos.getDirectionTo(nextPos));

  if (stroke && path.length > 0) {
    const room = creep.room.name;
    const localPoints = [creep.pos, ...path].filter((p) => p.roomName === room);
    if (localPoints.length > 1) {
      vizBuffer.push({ roomName: room, points: localPoints, stroke });
    }
  }
}

export function pathRoomCallback(roomName: string): boolean | CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    // Unseen room: skip if known to be owned by another player — their towers
    // will one-shot our creeps. Owned rooms we have vision into fall through
    // to the cost-matrix path below; if we lose vision briefly, the scoutedOwner
    // comparison against our username keeps our own rooms traversable.
    const owner = Memory.rooms?.[roomName]?.scoutedOwner;
    if (owner && owner !== getMyUsername()) return false;
    // Return an empty CostMatrix (not `true` or `undefined`) so terrain falls
    // through. Mixing `true`/`undefined` returns with real CostMatrix returns
    // for visible rooms confuses PathFinder when the visible room has 255
    // obstacles — observed with abandoned constructedWalls in W45N58, the
    // search would return incomplete with a first step pointing backward,
    // bouncing the creep across the border. Always returning a CostMatrix
    // (hivemind does the same) keeps PathFinder consistent.
    return new PathFinder.CostMatrix();
  }
  return getRoomCostMatrix(room);
}

// Same shape as pathRoomCallback but bumps friendly-creep cost — used by
// stuck-detection repaths so the new path actually routes around blockers.
export function pathRoomCallbackAvoidCreeps(roomName: string): boolean | CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    const owner = Memory.rooms?.[roomName]?.scoutedOwner;
    if (owner && owner !== getMyUsername()) return false;
    return new PathFinder.CostMatrix();
  }
  return getRoomCostMatrixAvoidCreeps(room);
}

// Sets all passable border tiles (exit tiles) to 255 in the given matrix.
// Used by in-room path searches so PathFinder never routes a creep onto an exit
// tile as a stopping point — the Screeps engine auto-evicts creeps that end a
// tick on a border exit tile to the adjacent room.
function blockExitTiles(costs: CostMatrix, room: Room): void {
  const terrain = room.getTerrain();
  for (let i = 0; i <= 49; i++) {
    if (terrain.get(0, i) !== TERRAIN_MASK_WALL) costs.set(0, i, 255);
    if (terrain.get(49, i) !== TERRAIN_MASK_WALL) costs.set(49, i, 255);
    if (terrain.get(i, 0) !== TERRAIN_MASK_WALL) costs.set(i, 0, 255);
    if (terrain.get(i, 49) !== TERRAIN_MASK_WALL) costs.set(i, 49, 255);
  }
}

// In-room callback: like pathRoomCallback but with exit tiles blocked.
function pathRoomCallbackNoExits(roomName: string): boolean | CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    const owner = Memory.rooms?.[roomName]?.scoutedOwner;
    if (owner && owner !== getMyUsername()) return false;
    return new PathFinder.CostMatrix();
  }
  const costs = getRoomCostMatrix(room).clone();
  blockExitTiles(costs, room);
  return costs;
}

// In-room callback: like pathRoomCallbackAvoidCreeps but with exit tiles blocked.
function pathRoomCallbackAvoidCreepsNoExits(roomName: string): boolean | CostMatrix {
  const room = Game.rooms[roomName];
  if (!room) {
    const owner = Memory.rooms?.[roomName]?.scoutedOwner;
    if (owner && owner !== getMyUsername()) return false;
    return new PathFinder.CostMatrix();
  }
  const costs = getRoomCostMatrixAvoidCreeps(room);
  blockExitTiles(costs, room);
  return costs;
}

function getPath(creep: Creep, target: RoomPosition, range: number): RoomPosition[] {
  const targetKey = `${target.x},${target.y},${target.roomName},${range}`;
  return cached(`traffic:path:${creep.name}`, () => {
    const serial = pathSerialCache.get(creep.name);
    // Invalidate cache when the target has changed.
    if (serial && serial.targetKey !== targetKey) {
      pathSerialCache.delete(creep.name);
    }
    const fresh = pathSerialCache.get(creep.name);
    if (fresh && Game.time - fresh.builtAt < PATH_SERIAL_TTL) {
      // Advance past any step the creep has already reached (handles normal
      // movement and the case where the creep was pushed forward by the engine).
      let head: RoomPosition | undefined;
      while (
        (head = fresh.path[0]) !== undefined &&
        head.x === creep.pos.x &&
        head.y === creep.pos.y &&
        head.roomName === creep.room.name
      ) {
        fresh.path.shift();
      }
      if (fresh.path.length > 0) return fresh.path;
    }
    const path = searchPath(creep, target, range, false);
    pathSerialCache.set(creep.name, { path: [...path], targetKey, builtAt: Game.time });
    return path;
  });
}

function searchPath(
  creep: Creep,
  target: RoomPosition,
  range: number,
  avoidCreeps: boolean,
): RoomPosition[] {
  const crossRoom = creep.pos.roomName !== target.roomName;
  const result = PathFinder.search(
    creep.pos,
    { pos: target, range },
    {
      plainCost: 2,
      swampCost: 10,
      // Diagonal / multi-hop targets (e.g. depth-3 scout, remote miners)
      // need to traverse intermediate rooms; the default of 2 is not enough,
      // and a cluttered room (constructedWalls, etc.) can force a multi-room
      // detour. 16 matches the Screeps default and hivemind's choice.
      maxRooms: crossRoom ? 16 : 1,
      // Raise in-room ops budget — 2000 is too tight for cluttered rooms and
      // can produce partial paths that point backward. Cross-room stays at 10000.
      maxOps: crossRoom ? 10000 : 5000,
      // For in-room paths, block exit tiles so PathFinder never picks a border
      // exit tile as a stopping point (which would trigger Screeps auto-eviction).
      // Cross-room paths must use exit tiles so they keep the normal callback.
      roomCallback: crossRoom
        ? avoidCreeps
          ? pathRoomCallbackAvoidCreeps
          : pathRoomCallback
        : avoidCreeps
          ? pathRoomCallbackAvoidCreepsNoExits
          : pathRoomCallbackNoExits,
    },
  );
  return result.path;
}

export function executeMoveAvoidCreeps(
  creep: Creep,
  target: RoomPosition,
  range: number,
  stroke?: string,
): void {
  if (creep.pos.inRangeTo(target, range)) return;
  // Bypass the per-creep tick cache so we don't reuse the path that got us stuck.
  const path = searchPath(creep, target, range, true);
  // Store the repath result so executeMove commits to it going forward instead
  // of immediately reverting to the original path on the next tick.
  const targetKey = `${target.x},${target.y},${target.roomName},${range}`;
  pathSerialCache.set(creep.name, { path: [...path], targetKey, builtAt: Game.time });
  const nextPos = path[0];
  if (!nextPos) return;

  creep.move(creep.pos.getDirectionTo(nextPos));

  if (stroke && path.length > 0) {
    const room = creep.room.name;
    const localPoints = [creep.pos, ...path].filter((p) => p.roomName === room);
    if (localPoints.length > 1) {
      vizBuffer.push({ roomName: room, points: localPoints, stroke });
    }
  }
}

// Heap-cached base matrix — terrain + structures only. Walking FIND_STRUCTURES
// every tick was a meaningful chunk of pathfinding cost, but structures rarely
// change tick-to-tick, so we cache and only rebuild when the structure count
// shifts (build/decay/destroy) or the TTL expires. The per-tick overlay below
// adds friendly creeps and hostiles on top of a clone.
interface BaseMatrixEntry {
  matrix: CostMatrix;
  builtAt: number;
  structureCount: number;
}
const baseMatrixCache = new Map<string, BaseMatrixEntry>();
const BASE_MATRIX_TTL = 100;

export function resetBaseMatrixCache(): void {
  baseMatrixCache.clear();
}

function buildBaseMatrix(structures: AnyStructure[]): CostMatrix {
  const costs = new PathFinder.CostMatrix();
  for (const struct of structures) {
    if (struct.structureType === STRUCTURE_ROAD) {
      costs.set(struct.pos.x, struct.pos.y, 1);
    } else if (
      struct.structureType !== STRUCTURE_CONTAINER &&
      !(struct.structureType === STRUCTURE_RAMPART && (struct as StructureRampart).my)
    ) {
      costs.set(struct.pos.x, struct.pos.y, 255);
    }
  }
  return costs;
}

export function getBaseCostMatrixForRoom(room: Room): CostMatrix {
  return getBaseCostMatrix(room);
}

function getBaseCostMatrix(room: Room): CostMatrix {
  // room.find is internally cached by the engine within a tick, so the count
  // probe is cheap on the cache-hit path; on miss we'd be calling find anyway.
  const structures = room.find(FIND_STRUCTURES);
  const cached = baseMatrixCache.get(room.name);
  if (
    cached &&
    Game.time - cached.builtAt < BASE_MATRIX_TTL &&
    cached.structureCount === structures.length
  ) {
    return cached.matrix;
  }
  const matrix = buildBaseMatrix(structures);
  baseMatrixCache.set(room.name, {
    matrix,
    builtAt: Game.time,
    structureCount: structures.length,
  });
  return matrix;
}

function applyCreepOverlay(room: Room, costs: CostMatrix, creepCost: number): void {
  for (const creep of room.find(FIND_MY_CREEPS)) {
    const current = costs.get(creep.pos.x, creep.pos.y);
    if (current < 255) {
      const cost = stationaryCreeps.has(creep.name) ? 255 : Math.max(current, creepCost);
      costs.set(creep.pos.x, creep.pos.y, cost);
    }
  }
  for (const hostile of room.find(FIND_HOSTILE_CREEPS)) {
    costs.set(hostile.pos.x, hostile.pos.y, 255);
  }
}

export function getRoomCostMatrix(room: Room): CostMatrix {
  return cached('traffic:costs:' + room.name, () => {
    const costs = getBaseCostMatrix(room).clone();
    // Moving friendly creeps are NOT added to the default matrix — their
    // soft-avoid cost was inflating corridors near idle hauler clusters and
    // pushing PathFinder onto longer detours. Stationary creeps (255) and
    // hostile creeps (255) are still hard obstacles.
    applyCreepOverlay(room, costs, 0);
    return costs;
  });
}

export function getRoomCostMatrixAvoidCreeps(room: Room): CostMatrix {
  // Not tick-cached — this is only ever called on a stuck repath, which is rare
  // enough that an extra pathfinder call per stuck creep is cheaper than a
  // second cached matrix slot per room.
  const costs = getBaseCostMatrix(room).clone();
  applyCreepOverlay(room, costs, 50);
  return costs;
}
