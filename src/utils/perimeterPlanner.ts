/**
 * Perimeter defense planner.
 *
 * Computes a `PerimeterPlan` for an owned room by BFS-flooding inward from all
 * room exit tiles, stopping at a "core zone" of Chebyshev radius `CORE_RADIUS`
 * from the spawn anchor. The algorithm:
 *
 *   1. Define the core zone: all passable tiles within Chebyshev distance
 *      CORE_RADIUS of the spawn/storage anchor.
 *   2. BFS from every passable room-border tile, treating terrain walls and the
 *      core zone as barriers → produces `exteriorSet` (tiles an attacker can
 *      reach without crossing the core).
 *   3. Perimeter = exterior tiles whose 8-neighbourhood contains at least one
 *      tile that is NOT exterior (i.e. interior/core boundary).
 *   4. Gates = perimeter tiles near each "gate target" (sources outside core,
 *      controller if distant, remote-room exit directions). Each gate is 2 tiles
 *      wide so haulers don't bottleneck.
 *
 * The plan is stored in `RoomMemory.perimeterPlan` and is invalidated/recomputed
 * when `PERIMETER_PLAN_VERSION` changes or when the set of remote rooms changes.
 *
 * Console: `replanPerimeter(roomName)` forces an immediate recompute.
 *
 * (A terrain-aware min-cut variant was prototyped and removed — live validation
 * showed it cost more wall than this radius ring for our rooms. See git history
 * around v1.0.216–v1.0.218 if it's ever worth revisiting against fresh data.)
 */

export const PERIMETER_PLAN_VERSION = 4;
export const CORE_RADIUS = 10;

// Minimum buildable tile coordinate (avoid border tiles which can't hold structures).
const BUILD_MIN = 2;
const BUILD_MAX = 47;

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function encodeXY(x: number, y: number): string {
  return `${x},${y}`;
}

function decodeXY(key: string): { x: number; y: number } {
  const comma = key.indexOf(',');
  return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

// -----------------------------------------------------------------------
// Gate target identification
// -----------------------------------------------------------------------

interface GateTarget {
  x: number;
  y: number;
  reason: string;
}

function getGateTargets(room: Room, spawnX: number, spawnY: number, mem: RoomMemory): GateTarget[] {
  const targets: GateTarget[] = [];

  // Sources that sit outside the core zone need gates for miner/hauler traffic.
  if (mem.sources) {
    for (const src of mem.sources) {
      if (chebyshev(src.x, src.y, spawnX, spawnY) > CORE_RADIUS) {
        targets.push({ x: src.x, y: src.y, reason: `source(${src.x},${src.y})` });
      }
    }
  }

  // Controller — if it's outside the core, upgraders need a gate.
  if (
    room.controller &&
    chebyshev(room.controller.pos.x, room.controller.pos.y, spawnX, spawnY) > CORE_RADIUS
  ) {
    targets.push({
      x: room.controller.pos.x,
      y: room.controller.pos.y,
      reason: 'controller',
    });
  }

  // Remote rooms — one gate toward each exit direction.
  if (mem.remoteRooms) {
    for (const remoteRoomName of mem.remoteRooms) {
      const exitDir = Game.map.findExit(room.name, remoteRoomName);
      if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) continue;

      // Find the room exit tile closest to our spawn — that's where the road
      // from spawn to the remote room will cross the perimeter boundary.
      const exitTiles = room.find(exitDir as FindConstant);
      if (!exitTiles || exitTiles.length === 0) continue;

      let bestTile: RoomPosition | undefined;
      let bestDist = Infinity;
      for (const tile of exitTiles as RoomPosition[]) {
        const d = chebyshev(tile.x, tile.y, spawnX, spawnY);
        if (d < bestDist) {
          bestDist = d;
          bestTile = tile;
        }
      }
      if (bestTile) {
        targets.push({ x: bestTile.x, y: bestTile.y, reason: `remote:${remoteRoomName}` });
      }
    }
  }

  // Fallback: if no targets found, add a gate toward the closest room exit tile
  // in each cardinal direction so the perimeter isn't a sealed box.
  if (targets.length === 0) {
    const allExits = [FIND_EXIT_TOP, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT, FIND_EXIT_RIGHT] as const;
    for (const dir of allExits) {
      const tiles = room.find(dir);
      if (!tiles || tiles.length === 0) continue;
      let bestTile: RoomPosition | undefined;
      let bestDist = Infinity;
      for (const tile of tiles as RoomPosition[]) {
        const d = chebyshev(tile.x, tile.y, spawnX, spawnY);
        if (d < bestDist) {
          bestDist = d;
          bestTile = tile;
        }
      }
      if (bestTile) {
        const dirName =
          dir === FIND_EXIT_TOP
            ? 'N'
            : dir === FIND_EXIT_BOTTOM
              ? 'S'
              : dir === FIND_EXIT_LEFT
                ? 'W'
                : 'E';
        targets.push({ x: bestTile.x, y: bestTile.y, reason: `default-${dirName}` });
      }
    }
  }

  return targets;
}

// -----------------------------------------------------------------------
// Gate tile identification
// -----------------------------------------------------------------------

/**
 * For each gate target, find the perimeter tile(s) closest to a straight-line
 * path from spawn to the target. Returns a 2-tile-wide gate set.
 */
function identifyGateTiles(
  perimeterSet: Set<string>,
  targets: GateTarget[],
  spawnX: number,
  spawnY: number,
): Set<string> {
  const gateTiles = new Set<string>();

  for (const target of targets) {
    // Place the gate where the straight line from spawn→target crosses the
    // perimeter — score each tile by the total Euclidean path spawn→tile→target.
    // That sum is minimised by the tile sitting on (and between) the spawn-target
    // line, so the gate aligns with the road that actually exits toward the target.
    //
    // (The earlier version scored Chebyshev distance to the target alone. For a
    // room-edge exit target — x or y pinned to 0/49 — that distance saturates on
    // the axis gap, so every tile on the facing wall tied and the gate landed on
    // an arbitrary corner instead of opposite the exit. Observed live in W43N58:
    // the W42N58 east gate stamped at the SE corner, not beside the exit.)
    let best: { key: string; score: number } | undefined;
    let secondBest: { key: string; score: number } | undefined;

    for (const key of perimeterSet) {
      const { x, y } = decodeXY(key);
      const score = Math.hypot(x - spawnX, y - spawnY) + Math.hypot(x - target.x, y - target.y);
      if (!best || score < best.score) {
        secondBest = best;
        best = { key, score };
      } else if (!secondBest || score < secondBest.score) {
        secondBest = { key, score };
      }
    }

    if (best) gateTiles.add(best.key);
    if (secondBest) gateTiles.add(secondBest.key);
  }

  return gateTiles;
}

// -----------------------------------------------------------------------
// Main algorithm
// -----------------------------------------------------------------------

/**
 * Compute the perimeter plan for an owned room. Returns undefined when the room
 * has no anchor (no spawn and no suggestedSpawnPos).
 */
export function computePerimeter(room: Room): PerimeterPlanData | undefined {
  const mem = Memory.rooms[room.name];
  if (!mem) return undefined;

  // Step 1: Determine anchor (spawn or suggested spawn position)
  let spawnX: number;
  let spawnY: number;

  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length > 0) {
    spawnX = spawns[0]!.pos.x;
    spawnY = spawns[0]!.pos.y;
  } else if (mem.suggestedSpawnPos) {
    spawnX = mem.suggestedSpawnPos.x;
    spawnY = mem.suggestedSpawnPos.y;
  } else if (mem.layoutPlan?.spawnPositions && mem.layoutPlan.spawnPositions.length > 0) {
    spawnX = mem.layoutPlan.spawnPositions[0]!.x;
    spawnY = mem.layoutPlan.spawnPositions[0]!.y;
  } else {
    return undefined;
  }

  // Step 2: Build terrain wall mask
  const terrain = Game.map.getRoomTerrain(room.name);

  // isWall(x, y): true if terrain is a wall tile (impassable to all creeps)
  function isWall(x: number, y: number): boolean {
    return (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0;
  }

  // Step 3: Define core zone
  // The core set is not explicitly stored; we just use chebyshev check inline.
  function isCore(x: number, y: number): boolean {
    return chebyshev(x, y, spawnX, spawnY) <= CORE_RADIUS && !isWall(x, y);
  }

  // Step 4: BFS from room border tiles to find exterior tiles
  const exteriorSet = new Set<string>();
  const queue: { x: number; y: number }[] = [];

  // Seed the BFS with all passable room border tiles
  for (let x = 0; x <= 49; x++) {
    for (const y of [0, 49]) {
      if (!isWall(x, y) && !isCore(x, y)) {
        const key = encodeXY(x, y);
        if (!exteriorSet.has(key)) {
          exteriorSet.add(key);
          queue.push({ x, y });
        }
      }
    }
  }
  for (let y = 1; y <= 48; y++) {
    for (const x of [0, 49]) {
      if (!isWall(x, y) && !isCore(x, y)) {
        const key = encodeXY(x, y);
        if (!exteriorSet.has(key)) {
          exteriorSet.add(key);
          queue.push({ x, y });
        }
      }
    }
  }

  // BFS outward — standard 4-direction + diagonals
  let qHead = 0;
  while (qHead < queue.length) {
    const curr = queue[qHead++]!;
    for (let d = 0; d < 8; d++) {
      const nx = curr.x + DX8[d]!;
      const ny = curr.y + DY8[d]!;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      if (isWall(nx, ny)) continue;
      if (isCore(nx, ny)) continue; // core is the BFS barrier
      const nkey = encodeXY(nx, ny);
      if (!exteriorSet.has(nkey)) {
        exteriorSet.add(nkey);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  // Step 5: Perimeter = exterior tiles that are buildable (2≤x≤47, 2≤y≤47)
  // and have at least one 8-direction neighbour that is NOT exterior.
  const perimeterSet = new Set<string>();
  for (const key of exteriorSet) {
    const { x, y } = decodeXY(key);
    if (x < BUILD_MIN || x > BUILD_MAX || y < BUILD_MIN || y > BUILD_MAX) continue;
    let bordersInterior = false;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d]!;
      const ny = y + DY8[d]!;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      if (isWall(nx, ny)) continue;
      const nkey = encodeXY(nx, ny);
      if (!exteriorSet.has(nkey)) {
        // nx,ny is non-exterior (interior or core)
        bordersInterior = true;
        break;
      }
    }
    if (bordersInterior) perimeterSet.add(key);
  }

  // Step 6: Gate targets and gate tiles
  const gateTargets = getGateTargets(room, spawnX, spawnY, mem);
  const gateTilesSet = identifyGateTiles(perimeterSet, gateTargets, spawnX, spawnY);

  return {
    version: PERIMETER_PLAN_VERSION,
    coreRadius: CORE_RADIUS,
    perimeterTiles: [...perimeterSet],
    gateTiles: [...gateTilesSet],
    gateTargets,
  };
}

/**
 * Console helper — force-recomputes the perimeter plan for the given room.
 * Returns a summary string.
 */
export function replanPerimeterForRoom(roomName: string): string {
  const room = Game.rooms[roomName];
  if (!room) return `Room ${roomName} not visible`;
  if (!room.controller?.my) return `Room ${roomName} is not owned`;

  const mem = (Memory.rooms[roomName] ??= {});
  delete mem.perimeterPlan;

  const plan = computePerimeter(room);
  if (!plan) return `Could not compute perimeter for ${roomName} (no anchor)`;

  mem.perimeterPlan = plan;
  const wallCount = plan.perimeterTiles.filter((k) => !plan.gateTiles.includes(k)).length;
  return (
    `Perimeter planned for ${roomName}: ` +
    `${plan.perimeterTiles.length} perimeter tiles, ` +
    `${plan.gateTiles.length} gate tiles, ` +
    `${wallCount} wall positions, ` +
    `${plan.gateTargets.length} gate targets (${plan.gateTargets.map((t) => t.reason).join(', ')})`
  );
}
