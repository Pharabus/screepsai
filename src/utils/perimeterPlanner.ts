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
 * Min-cut variant: `computeMinCutPerimeter(room)` uses a vertex-split Dinic's
 * max-flow (`minCut.ts`) to find the terrain-aware minimum barrier, protecting a
 * bounding box of the core structures (+`PROTECT_MARGIN`) so the cut leans on
 * nearby natural walls. Controlled by the `Memory.perimeterMinCut` flag and
 * mirrored into `RoomMemory.perimeterPreview` for the `runVisuals` A/B overlay.
 *
 * ── SHELVED (off by default), v1.0.216 ──────────────────────────────────────
 * WHAT: a complete, unit-tested, terrain-aware perimeter. Dormant behind the
 *   flag; `computePerimeter` (the fixed-radius BFS) stays authoritative.
 * WHY OFF: live validation on W43N58 (spawn 16,31) showed the *sealed* min-cut
 *   costs MORE than the radius ring, not less. Tightening the protected region
 *   to drop a redundant-looking wall (the x27 column parallel to the x22–25
 *   mountain) drags the barrier toward the room edges to reach those walls, and
 *   sealing against the unbuildable edge (the x1/y1/x48/y48 ring) is expensive:
 *   min-cut 75 walls vs radius 70, while protecting a smaller area. The earlier
 *   "−24%" figure was an artifact of a barrier that wasn't actually sealing.
 *   Min-cut only wins when the natural walls sit near the CORE, not the edges;
 *   W43N58's geometry favours a compact interior ring. (Measure before
 *   optimising / live validation is ground truth.)
 * WHEN TO REVISIT: rooms whose natural walls hug the core — flip
 *   `Memory.perimeterMinCut = true` (console `perimeterMinCut(true)`), run
 *   `replanPerimeter(room)`, and compare the overlay + the count diff per room.
 * CONFLICTS / GOTCHAS: barrier tiles MUST be allowed on the edge-adjacent ring
 *   (minCut.ts BUILD_MIN=1/BUILD_MAX=48) or the cut leaks through the x1 lane —
 *   see the seal regression test. Gate targets here use protected-set
 *   membership, not CORE_RADIUS, since the tighter region can leave a
 *   source/controller outside the box.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { computeMinCut } from './minCut';

export const PERIMETER_PLAN_VERSION = 3;
export const CORE_RADIUS = 10;
/**
 * Tiles of padding added around the core-structure bounding box when computing
 * the min-cut protected region. Tight enough that the barrier leans on nearby
 * natural walls instead of walling a parallel ring just outside them.
 */
export const PROTECT_MARGIN = 2;

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

/**
 * Remote-room exit gate targets (one per remote room, toward the exit tile
 * closest to the anchor). Shared by the radius and min-cut planners.
 */
function remoteGateTargets(
  room: Room,
  spawnX: number,
  spawnY: number,
  mem: RoomMemory,
): GateTarget[] {
  const targets: GateTarget[] = [];
  if (!mem.remoteRooms) return targets;
  for (const remoteRoomName of mem.remoteRooms) {
    const exitDir = Game.map.findExit(room.name, remoteRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) continue;
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
  return targets;
}

/**
 * Default cardinal-direction gate targets — one per exit direction, toward the
 * exit tile closest to the anchor. Used when no source/controller/remote target
 * fired, so the perimeter isn't a sealed box.
 */
function defaultGateTargets(room: Room, spawnX: number, spawnY: number): GateTarget[] {
  const targets: GateTarget[] = [];
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
  return targets;
}

/**
 * Core structure positions used to bound the min-cut protected region:
 * layoutPlan positions (planned) UNION live-built core structures UNION the
 * anchor. The anchor guarantees the set is never empty.
 */
function collectCorePositions(
  room: Room,
  mem: RoomMemory,
  spawnX: number,
  spawnY: number,
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [{ x: spawnX, y: spawnY }];

  const lp = mem.layoutPlan;
  if (lp) {
    if (lp.spawnPositions) for (const p of lp.spawnPositions) positions.push({ x: p.x, y: p.y });
    if (lp.storagePos) positions.push({ x: lp.storagePos.x, y: lp.storagePos.y });
    if (lp.terminalPos) positions.push({ x: lp.terminalPos.x, y: lp.terminalPos.y });
    if (lp.factoryPos) positions.push({ x: lp.factoryPos.x, y: lp.factoryPos.y });
    for (const p of lp.towerPositions ?? []) positions.push({ x: p.x, y: p.y });
    for (const p of lp.labPositions ?? []) positions.push({ x: p.x, y: p.y });
    for (const p of lp.extensionPositions ?? []) positions.push({ x: p.x, y: p.y });
  }

  // Live-built core structures (handles rooms with structures but stale/no plan).
  const coreTypes = new Set<string>([
    STRUCTURE_SPAWN,
    STRUCTURE_EXTENSION,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_LAB,
    STRUCTURE_FACTORY,
    STRUCTURE_LINK,
    STRUCTURE_NUKER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_OBSERVER,
  ]);
  const built = room.find(FIND_MY_STRUCTURES, {
    filter: (s: AnyOwnedStructure) => coreTypes.has(s.structureType),
  });
  for (const s of built) positions.push({ x: s.pos.x, y: s.pos.y });

  return positions;
}

/**
 * Gate targets for the min-cut planner. Sources/controller are gated by
 * protected-set membership (a target inside the protected box needs no gate);
 * remote-room exits are unconditional. Falls back to cardinal-direction gates
 * when nothing else fired.
 */
function buildMinCutGateTargets(
  room: Room,
  mem: RoomMemory,
  protectedSet: Set<string>,
  spawnX: number,
  spawnY: number,
): GateTarget[] {
  const targets: GateTarget[] = [];

  // Sources outside the protected box need gates for miner/hauler traffic.
  if (mem.sources) {
    for (const src of mem.sources) {
      if (!protectedSet.has(encodeXY(src.x, src.y))) {
        targets.push({ x: src.x, y: src.y, reason: `source(${src.x},${src.y})` });
      }
    }
  }

  // Controller outside the protected box needs a gate for upgraders.
  if (room.controller) {
    const cx = room.controller.pos.x;
    const cy = room.controller.pos.y;
    if (!protectedSet.has(encodeXY(cx, cy))) {
      targets.push({ x: cx, y: cy, reason: 'controller' });
    }
  }

  // Remote-room exits — always gated.
  targets.push(...remoteGateTargets(room, spawnX, spawnY, mem));

  // Fallback: no targets at all → cardinal default gates so it's not sealed.
  if (targets.length === 0) {
    targets.push(...defaultGateTargets(room, spawnX, spawnY));
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
function identifyGateTiles(perimeterSet: Set<string>, targets: GateTarget[]): Set<string> {
  const gateTiles = new Set<string>();

  for (const target of targets) {
    // Score each perimeter tile by how close it sits to the line from spawn→target.
    // We use the distance of each perimeter tile from the target (close = on the path).
    let best: { key: string; dist: number } | undefined;
    let secondBest: { key: string; dist: number } | undefined;

    for (const key of perimeterSet) {
      const { x, y } = decodeXY(key);
      // Primary sort: proximity to the target (i.e. this tile is the first wall
      // an attacker coming from the target would hit — so it's the natural gate).
      const dist = chebyshev(x, y, target.x, target.y);
      if (!best || dist < best.dist) {
        secondBest = best;
        best = { key, dist };
      } else if (!secondBest || dist < secondBest.dist) {
        secondBest = { key, dist };
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
  const gateTilesSet = identifyGateTiles(perimeterSet, gateTargets);

  return {
    version: PERIMETER_PLAN_VERSION,
    coreRadius: CORE_RADIUS,
    perimeterTiles: [...perimeterSet],
    gateTiles: [...gateTilesSet],
    gateTargets,
    algo: 'radius' as const,
  };
}

// -----------------------------------------------------------------------
// Min-cut perimeter computation
// -----------------------------------------------------------------------

/**
 * Compute a terrain-aware perimeter plan using min-cut max-flow.
 *
 * Uses the same anchor and gate-target logic as `computePerimeter`; the
 * difference is that the barrier hugs natural walls instead of forming a fixed
 * Chebyshev-radius box.
 *
 * Gate identification uses PathFinder.search to find the actual path from the
 * anchor to each gate target, with barrier tiles treated as passable — the
 * barrier tile(s) the path crosses are promoted to gates (rampart-only),
 * widened to 2 tiles by including an adjacent barrier neighbour.
 *
 * Returns undefined when no anchor is available (matches `computePerimeter`).
 */
export function computeMinCutPerimeter(room: Room): PerimeterPlanData | undefined {
  const mem = Memory.rooms[room.name];
  if (!mem) return undefined;

  // Step 1: Anchor resolution (identical to computePerimeter)
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

  // Step 2: Terrain predicate
  const terrain = Game.map.getRoomTerrain(room.name);
  function isWall(x: number, y: number): boolean {
    return (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0;
  }

  // Step 3: Protected set = non-wall tiles inside the core-structure bounding
  // box (expanded by PROTECT_MARGIN). Tightening to the actual structures —
  // rather than a fixed Chebyshev radius — lets the min-cut lean on nearby
  // natural walls instead of walling a redundant ring just outside them.
  const corePositions = collectCorePositions(room, mem, spawnX, spawnY);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corePositions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const protectedSet = new Set<string>();
  if (Number.isFinite(minX)) {
    // Bounding-box region (anchor is always in corePositions, so this branch
    // is the normal path once any structure/layout position exists).
    const x0 = Math.max(BUILD_MIN, minX - PROTECT_MARGIN);
    const x1 = Math.min(BUILD_MAX, maxX + PROTECT_MARGIN);
    const y0 = Math.max(BUILD_MIN, minY - PROTECT_MARGIN);
    const y1 = Math.min(BUILD_MAX, maxY + PROTECT_MARGIN);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isWall(x, y)) protectedSet.add(encodeXY(x, y));
      }
    }
  } else {
    // Fallback (should be unreachable — anchor is always included): radius box
    // around the anchor, matching the legacy behaviour for unplanned rooms.
    for (let y = Math.max(0, spawnY - CORE_RADIUS); y <= Math.min(49, spawnY + CORE_RADIUS); y++) {
      for (
        let x = Math.max(0, spawnX - CORE_RADIUS);
        x <= Math.min(49, spawnX + CORE_RADIUS);
        x++
      ) {
        if (chebyshev(x, y, spawnX, spawnY) <= CORE_RADIUS && !isWall(x, y)) {
          protectedSet.add(encodeXY(x, y));
        }
      }
    }
  }

  // Step 4: Compute min-cut barrier
  const barrierTiles = computeMinCut({ isWall, protected: protectedSet });
  const barrierSet = new Set<string>(barrierTiles.map((t) => encodeXY(t.x, t.y)));

  // Step 5: Gate targets — membership-based for sources/controller.
  // With a tight protected box, a source/controller can sit outside the box yet
  // within CORE_RADIUS; the radius-gated getGateTargets would then omit a needed
  // gate and wall it out. Gate iff the target tile is NOT in the protected set.
  // Remote-room exit targets reuse getGateTargets (which only emits remotes when
  // no source/controller/default fired — we union them explicitly below).
  const gateTargets = buildMinCutGateTargets(room, mem, protectedSet, spawnX, spawnY);

  // Step 6: PathFinder-based gate identification
  // For each target, route from anchor to target treating barrier tiles as passable.
  // The barrier tile(s) the path crosses are the gate(s); widen to 2 by including
  // an adjacent barrier tile if available.
  const anchorPos = new RoomPosition(spawnX, spawnY, room.name);

  // Build the gate-routing cost matrix ONCE — it's identical for every target
  // (depends only on terrain walls + the barrier set, not the destination).
  // Walls are impassable; barrier tiles are passable at cost 1 so the path
  // threads through them, revealing where each route crosses the barrier.
  const gateMatrix = new PathFinder.CostMatrix();
  for (let y = 0; y <= 49; y++) {
    for (let x = 0; x <= 49; x++) {
      if (isWall(x, y)) gateMatrix.set(x, y, 255);
    }
  }
  for (const key of barrierSet) {
    const { x, y } = decodeXY(key);
    gateMatrix.set(x, y, 1);
  }

  const gateTilesSet = new Set<string>();

  for (const target of gateTargets) {
    const targetPos = new RoomPosition(target.x, target.y, room.name);

    // PathFinder: barrier tiles are passable (cost 1); walls blocked
    const result = PathFinder.search(
      anchorPos,
      { pos: targetPos, range: 1 },
      {
        roomCallback: (rName: string) => (rName === room.name ? gateMatrix : false),
        maxRooms: 1,
      },
    );

    // Find which barrier tile(s) the path crosses
    let firstBarrierKey: string | undefined;
    for (const pos of result.path) {
      const key = encodeXY(pos.x, pos.y);
      if (barrierSet.has(key)) {
        gateTilesSet.add(key);
        firstBarrierKey = key;
        break; // first crossing is the gate tile
      }
    }

    // Widen gate to 2 by adding an adjacent barrier tile
    if (firstBarrierKey) {
      const { x: gx, y: gy } = decodeXY(firstBarrierKey);
      let added = false;
      for (let d = 0; d < 8 && !added; d++) {
        const nx = gx + DX8[d]!;
        const ny = gy + DY8[d]!;
        const nkey = encodeXY(nx, ny);
        if (barrierSet.has(nkey) && !gateTilesSet.has(nkey)) {
          gateTilesSet.add(nkey);
          added = true;
        }
      }
    }
  }

  // Fallback: if PathFinder gave no path (e.g. target is isolated), use the
  // proximity-based approach as a safety net (same as identifyGateTiles).
  if (gateTilesSet.size === 0 && gateTargets.length > 0) {
    const fallback = identifyGateTiles(barrierSet, gateTargets);
    for (const k of fallback) gateTilesSet.add(k);
  }

  return {
    version: PERIMETER_PLAN_VERSION,
    coreRadius: CORE_RADIUS,
    perimeterTiles: [...barrierSet],
    gateTiles: [...gateTilesSet],
    gateTargets,
    algo: 'mincut' as const,
  };
}

// -----------------------------------------------------------------------
// Selector: pick algorithm based on Memory flag
// -----------------------------------------------------------------------

/**
 * Returns `computeMinCutPerimeter(room)` when `Memory.perimeterMinCut` is true,
 * otherwise returns `computePerimeter(room)` (the fixed-radius BFS).
 */
export function planPerimeter(room: Room): PerimeterPlanData | undefined {
  if (Memory.perimeterMinCut) {
    return computeMinCutPerimeter(room);
  }
  return computePerimeter(room);
}

// -----------------------------------------------------------------------
// Console helper
// -----------------------------------------------------------------------

function formatPlanSummary(label: string, plan: PerimeterPlanData): string {
  const wallCount = plan.perimeterTiles.filter((k) => !plan.gateTiles.includes(k)).length;
  return (
    `${label} (${plan.algo}): ` +
    `${plan.perimeterTiles.length} perimeter tiles, ` +
    `${plan.gateTiles.length} gate tiles, ` +
    `${wallCount} wall positions`
  );
}

/**
 * Console helper — force-recomputes the perimeter plan for the given room.
 * Computes both the authoritative plan (via `planPerimeter`) and the min-cut
 * candidate (always), stores authoritative in `perimeterPlan` and the min-cut
 * candidate in `perimeterPreview`, and returns a text diff of counts.
 */
export function replanPerimeterForRoom(roomName: string): string {
  const room = Game.rooms[roomName];
  if (!room) return `Room ${roomName} not visible`;
  if (!room.controller?.my) return `Room ${roomName} is not owned`;

  const mem = (Memory.rooms[roomName] ??= {});
  delete mem.perimeterPlan;
  delete mem.perimeterPreview;

  const authPlan = planPerimeter(room);
  if (!authPlan) return `Could not compute perimeter for ${roomName} (no anchor)`;
  mem.perimeterPlan = authPlan;

  const minCutPlan = computeMinCutPerimeter(room);
  if (minCutPlan) mem.perimeterPreview = minCutPlan;

  const lines: string[] = [];
  lines.push(`Perimeter replanned for ${roomName}:`);
  lines.push(`  authoritative: ${formatPlanSummary('plan', authPlan)}`);
  if (minCutPlan) {
    lines.push(`  preview:       ${formatPlanSummary('mincut', minCutPlan)}`);
    const tilesDiff = minCutPlan.perimeterTiles.length - authPlan.perimeterTiles.length;
    const wallsDiff =
      minCutPlan.perimeterTiles.filter((k) => !minCutPlan.gateTiles.includes(k)).length -
      authPlan.perimeterTiles.filter((k) => !authPlan.gateTiles.includes(k)).length;
    lines.push(
      `  diff: tiles ${tilesDiff >= 0 ? '+' : ''}${tilesDiff}, ` +
        `walls ${wallsDiff >= 0 ? '+' : ''}${wallsDiff}`,
    );
  } else {
    lines.push(`  preview: could not compute min-cut plan (no anchor?)`);
  }
  lines.push(`  gate targets: ${authPlan.gateTargets.map((t) => t.reason).join(', ') || '(none)'}`);
  return lines.join('\n');
}
