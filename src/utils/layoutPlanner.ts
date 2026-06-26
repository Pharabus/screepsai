import { myStorage } from './ownership';

// Lab stamp: [dx, dy] offsets from lab anchor = storagePos + (2,2).
// Positions 0-1 are input labs; 2-9 are output labs.
// RCL 6 → 3 labs (indices 0-2), RCL 7 → 9 labs (indices 0-8), RCL 8 → 10 labs (all).
export const LAB_STAMP: [number, number][] = [
  [0, 0], // input 1
  [1, 1], // input 2
  [0, 1], // output — RCL 6 cap (3 total)
  [1, 0], // output
  [2, 1], // output
  [1, 2], // output
  [2, 0], // output
  [0, 2], // output
  [2, 2], // output — RCL 7 cap (9 total)
  [-1, 1], // output — RCL 8 cap (10 total)
];

// Extension stamp: [dx, dy] from spawn, ordered closest-first.
// Leaves dx=0 and dy=0 as road corridors.
export const EXTENSION_STAMP: [number, number][] = [
  [-1, -2],
  [1, -2],
  [-2, -1],
  [2, -1],
  [-2, 1],
  [2, 1],
  [-1, 2],
  [1, 2],
  [-2, -2],
  [2, -2],
  [-2, 2],
  [2, 2],
  [-1, -3],
  [1, -3],
  [-3, -1],
  [3, -1],
  [-3, 1],
  [3, 1],
  [-1, 3],
  [1, 3],
  [-3, -2],
  [3, -2],
  [-3, 2],
  [3, 2],
  [-2, -3],
  [2, -3],
  [-2, 3],
  [2, 3],
  [-3, -3],
  [3, -3],
  [-3, 3],
  [3, 3],
  [-1, -4],
  [1, -4],
  [-4, -1],
  [4, -1],
  [-4, 1],
  [4, 1],
  [-1, 4],
  [1, 4],
  [-4, -2],
  [4, -2],
  [-4, 2],
  [4, 2],
  [-2, -4],
  [2, -4],
  [-2, 4],
  [2, 4],
  [-4, -3],
  [4, -3],
  [-4, 3],
  [4, 3],
  [-3, -4],
  [3, -4],
  [-3, 4],
  [3, 4],
  [-4, -4],
  [4, -4],
  [-4, 4],
  [4, 4],
];

/** Bump when layout semantics change to auto-invalidate stale cached plans. */
export const LAYOUT_PLAN_VERSION = 7;

/**
 * Minimum walkable tiles to keep open around the storage. The storage is the
 * room's busiest tile — every hauler/worker that withdraws or deposits must
 * stand on an adjacent tile, so too few access tiles deadlocks creeps queueing
 * for the one opening (observed live W44N57: storage boxed to a single open
 * neighbour by extensions, ~5 creeps frozen in the approach corridor). Raised
 * from 3 to 4: with MIN=3 the reservation stopped one tile short, leaving a
 * corridor-connecting neighbour unguarded so the stamp re-extended onto it —
 * the boxed-core regression in W44N57 was a direct consequence. Only ever
 * reserves already-open walkable neighbours, so healthy built rooms are
 * unaffected. Reserved before extension placement so the stamp can never
 * close them off.
 */
const STORAGE_ACCESS_MIN = 4;

/**
 * Minimum walkable tiles to keep open around each planned spawn position.
 * A spawn with zero open neighbours can't create creeps (no adjacent tile for
 * the new creep to appear on) and can't be refilled by haulers. Observed live
 * W44N57: spawn 2 at (24,4) completely sealed by 8 surrounding extensions —
 * no reservation existed for spawn access unlike the storage reservation above.
 */
const SPAWN_ACCESS_MIN = 2;

export interface LayoutPlan {
  version: number;
  storagePos: { x: number; y: number };
  terminalPos: { x: number; y: number };
  factoryPos?: { x: number; y: number };
  towerPositions: { x: number; y: number }[];
  labPositions: { x: number; y: number }[];
  extensionPositions: { x: number; y: number }[];
  /** Up to 3 spawn positions. Index 0 = primary/live spawn. Index 1-2 = 2nd/3rd spawns at RCL 7-8. */
  spawnPositions: { x: number; y: number }[];
}

function inBounds(x: number, y: number): boolean {
  return x >= 2 && x <= 47 && y >= 2 && y <= 47;
}

/**
 * Builds a map of "x,y" → structureType for every non-rampart live structure and
 * construction site in the room. Built once per computeLayout call and threaded
 * through all picker functions so we never call room.find inside a tight loop.
 */
function buildLiveMap(room: Room): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_RAMPART) continue;
    m.set(`${s.pos.x},${s.pos.y}`, s.structureType);
  }
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    if (cs.structureType === STRUCTURE_RAMPART) continue;
    const key = `${cs.pos.x},${cs.pos.y}`;
    if (!m.has(key)) m.set(key, cs.structureType as string);
  }
  return m;
}

/**
 * Returns true if tile (x,y) is available for planning a structure of `forType`.
 * Filter rules:
 * - STRUCTURE_RAMPART: excluded from liveMap (coexists with everything).
 * - STRUCTURE_ROAD: blocks tower/lab/extension/storage/terminal — allowed only for
 *   the road planner itself.
 * - STRUCTURE_WALL, STRUCTURE_CONTAINER: block.
 * - Any structure of a *different* type: blocks.
 * - An existing structure of the *same* type as `forType`: honored in-place (returns
 *   true) so a replan on a populated room preserves already-built positions.
 */
function isTileBuildable(
  liveMap: Map<string, string>,
  x: number,
  y: number,
  forType: string,
): boolean {
  const existing = liveMap.get(`${x},${y}`);
  return !existing || existing === forType;
}

const NON_WALKABLE_STRUCTURES = new Set<string>([
  STRUCTURE_LAB,
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
  STRUCTURE_TOWER,
  STRUCTURE_LINK,
  STRUCTURE_WALL,
]);

const CARDINALS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** All 8 surrounding offsets — range-1 reach (withdraw/transfer/build) includes diagonals. */
const EIGHT_NEIGHBORS: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Returns false if placing a non-walkable structure at (x, y) would leave any
 * adjacent planned-or-built non-walkable structure with zero walkable neighbours.
 * Prevents the W43N58 corridor-strand bug.
 */
function isAccessible(
  x: number,
  y: number,
  terrain: RoomTerrain,
  liveMap: Map<string, string>,
  reserved: Set<string>,
): boolean {
  const isWalkableFrom = (cx: number, cy: number): boolean => {
    if (cx === x && cy === y) return false;
    if (!inBounds(cx, cy)) return false;
    if (terrain.get(cx, cy) === TERRAIN_MASK_WALL) return false;
    const t = liveMap.get(`${cx},${cy}`);
    if (t && NON_WALKABLE_STRUCTURES.has(t)) return false;
    if (reserved.has(`${cx},${cy}`)) return false;
    return true;
  };

  if (!CARDINALS.some(([dx, dy]) => isWalkableFrom(x + dx, y + dy))) return false;

  for (const [dx, dy] of CARDINALS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const nType = liveMap.get(`${nx},${ny}`);
    const isNonWalkable =
      (nType !== undefined && NON_WALKABLE_STRUCTURES.has(nType)) || reserved.has(`${nx},${ny}`);
    if (!isNonWalkable) continue;
    if (!CARDINALS.some(([cdx, cdy]) => isWalkableFrom(nx + cdx, ny + cdy))) return false;
  }

  return true;
}

/**
 * Shared 8-directional flood-fill core.
 *
 * Walks all tiles reachable from `seeds` where a tile is walkable when it is
 * in-bounds, not a terrain wall, and not present in `obstacleKeys`.
 * Returns the set of reachable "x,y" keys (seeds themselves included).
 */
function floodReachable(
  seeds: { x: number; y: number }[],
  obstacleKeys: Set<string>,
  terrain: RoomTerrain,
): Set<string> {
  const isWalkable = (x: number, y: number): boolean => {
    if (!inBounds(x, y)) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
    return !obstacleKeys.has(`${x},${y}`);
  };

  const reachable = new Set<string>();
  const stack: { x: number; y: number }[] = [];
  for (const s of seeds) {
    const k = `${s.x},${s.y}`;
    if (!reachable.has(k) && isWalkable(s.x, s.y)) {
      reachable.add(k);
      stack.push(s);
    }
  }
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const [dx, dy] of EIGHT_NEIGHBORS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(nx, ny)) continue;
      const nk = `${nx},${ny}`;
      if (reachable.has(nk)) continue;
      reachable.add(nk);
      stack.push({ x: nx, y: ny });
    }
  }
  return reachable;
}

/** Collect the 8 walkable neighbours of `pos` that are not in `obstacleKeys`. */
function walkableNeighbourSeeds(
  pos: { x: number; y: number },
  obstacleKeys: Set<string>,
  terrain: RoomTerrain,
): { x: number; y: number }[] {
  const seeds: { x: number; y: number }[] = [];
  for (const [dx, dy] of EIGHT_NEIGHBORS) {
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    if (!inBounds(nx, ny)) continue;
    if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
    if (obstacleKeys.has(`${nx},${ny}`)) continue;
    seeds.push({ x: nx, y: ny });
  }
  return seeds;
}

/**
 * Transitive reachability prune for extension positions.
 *
 * The local accessibility checks (`isAccessible`, overflow `wouldTrap`) only inspect
 * immediate cardinal neighbours — they cannot detect a case where the approach tile
 * is itself inside a sealed pocket unreachable from the spawn (live: W44N57 extension
 * 30,9 whose only walkable neighbour 29,9 was a 1-tile road pocket sealed by other
 * planned obstacles). This helper flood-fills (8-directional) from the spawn's walkable
 * neighbours and drops any extension that has no adjacent reachable tile.
 *
 * **Fixpoint loop:** after dropping an unreachable extension its tile becomes walkable,
 * which can rescue a neighbour. Repeats until stable (converges because dropping only
 * opens tiles). Bounded by `extensionPositions.length` iterations to guard against
 * degenerate inputs.
 *
 * **Fail open:** if the spawn has no walkable seed neighbours (degenerate room), returns
 * `extensionPositions` unchanged rather than nuking everything.
 *
 * @param extensionPositions  candidate extension tiles (mutated copy is returned)
 * @param plannedObstacleKeys mutable set of all planned + built non-walkable tile keys
 *   (spawn, storage, terminal, factory, labs, towers, spawns, and every extension);
 *   unreachable extensions are removed from this set so their tiles become walkable.
 * @param terrain             room terrain for wall checks
 * @param spawnPos            primary spawn tile (it is itself an obstacle; flood seeds
 *   from its 8 walkable neighbours)
 */
export function pruneUnreachableExtensions(
  extensionPositions: { x: number; y: number }[],
  plannedObstacleKeys: Set<string>,
  terrain: RoomTerrain,
  spawnPos: { x: number; y: number },
  builtExtensions?: { x: number; y: number }[],
): { x: number; y: number }[] {
  // Seed from spawn's 8 walkable neighbours (spawn itself is an obstacle).
  const seeds = walkableNeighbourSeeds(spawnPos, plannedObstacleKeys, terrain);

  // Fail open: if no seeds exist (degenerate room), return the list unchanged.
  if (seeds.length === 0) return extensionPositions;

  let remaining = [...extensionPositions];
  const maxIter = extensionPositions.length + 1;

  for (let iter = 0; iter < maxIter; iter++) {
    const reachable = floodReachable(seeds, plannedObstacleKeys, terrain);

    // Find planned extensions with no reachable 8-neighbour (stranded).
    const stranded = remaining.filter(
      ({ x, y }) => !EIGHT_NEIGHBORS.some(([dx, dy]) => reachable.has(`${x + dx},${y + dy}`)),
    );

    // Check built extensions: if planned extensions seal a built one, BFS
    // through the unreachable pocket to find the sealing planned extensions
    // and drop them. The seal may be indirect — a planned extension 2+ tiles
    // away can seal a built extension via an intermediate walkable pocket tile
    // (W42N59: planned at (21,19)/(21,20) sealed built (19,19) via pocket (20,19)).
    const sealingKeys = new Set<string>();
    if (builtExtensions) {
      const remainingKeys = new Set(remaining.map((p) => `${p.x},${p.y}`));
      for (const bp of builtExtensions) {
        const hasReachableNeighbour = EIGHT_NEIGHBORS.some(([dx, dy]) =>
          reachable.has(`${bp.x + dx},${bp.y + dy}`),
        );
        if (!hasReachableNeighbour) {
          const visited = new Set<string>();
          const queue: { x: number; y: number }[] = [bp];
          visited.add(`${bp.x},${bp.y}`);
          while (queue.length > 0) {
            const cur = queue.shift()!;
            for (const [dx, dy] of EIGHT_NEIGHBORS) {
              const nx = cur.x + dx;
              const ny = cur.y + dy;
              if (!inBounds(nx, ny)) continue;
              const nk = `${nx},${ny}`;
              if (visited.has(nk)) continue;
              visited.add(nk);
              if (remainingKeys.has(nk)) {
                sealingKeys.add(nk);
              } else if (
                !reachable.has(nk) &&
                terrain.get(nx, ny) !== TERRAIN_MASK_WALL &&
                !plannedObstacleKeys.has(nk)
              ) {
                queue.push({ x: nx, y: ny });
              }
            }
          }
        }
      }
    }

    if (stranded.length === 0 && sealingKeys.size === 0) break;

    // Remove stranded and sealing extensions from both the candidate list and
    // the obstacle set so their tiles become walkable for the next flood pass.
    for (const p of stranded) {
      plannedObstacleKeys.delete(`${p.x},${p.y}`);
    }
    for (const k of sealingKeys) {
      plannedObstacleKeys.delete(k);
    }
    const dropKeys = new Set([...stranded.map((p) => `${p.x},${p.y}`), ...sealingKeys]);
    remaining = remaining.filter((p) => !dropKeys.has(`${p.x},${p.y}`));
  }

  return remaining;
}

/**
 * Finds already-BUILT extensions and extension construction sites whose 8 neighbours
 * contain no tile reachable from the room's spawn via walkable (non-wall,
 * non-NON_WALKABLE_STRUCTURES) tiles.
 *
 * Used by the `strandedExtensions(roomName)` console command to diagnose live rooms
 * after a plan has already been built — the planner's prune only prevents NEW stranded
 * extensions; this surfaces ones that slipped through before v6 was deployed.
 *
 * Obstacle set = every built NON_WALKABLE_STRUCTURES tile + every extension construction
 * site (sites are passable for pathing but act as obstacles for approach purposes since
 * a creep can't stand on them to interact). Extension structures themselves are also
 * obstacles (creeps must approach from a neighbour, not stand on the extension).
 *
 * Fail open: returns [] if the room has no spawn or all spawn neighbours are blocked.
 */
export function findStrandedExtensions(room: Room): { x: number; y: number; built: boolean }[] {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return [];

  const terrain = room.getTerrain();

  // Build obstacle set: all built non-walkable structures + extension CSes.
  const obstacleKeys = new Set<string>();
  for (const s of room.find(FIND_STRUCTURES)) {
    if (NON_WALKABLE_STRUCTURES.has(s.structureType)) {
      obstacleKeys.add(`${s.pos.x},${s.pos.y}`);
    }
  }
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES)) {
    if (cs.structureType === STRUCTURE_EXTENSION) {
      obstacleKeys.add(`${cs.pos.x},${cs.pos.y}`);
    }
  }

  // Seed flood from spawn's 8 walkable neighbours.
  const seeds = walkableNeighbourSeeds(spawn.pos, obstacleKeys, terrain);
  if (seeds.length === 0) return []; // fail open

  const reachable = floodReachable(seeds, obstacleKeys, terrain);

  const results: { x: number; y: number; built: boolean }[] = [];

  // Check built extensions.
  for (const s of room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  })) {
    const hasReachableNeighbour = EIGHT_NEIGHBORS.some(([dx, dy]) =>
      reachable.has(`${s.pos.x + dx},${s.pos.y + dy}`),
    );
    if (!hasReachableNeighbour) results.push({ x: s.pos.x, y: s.pos.y, built: true });
  }

  // Check extension construction sites.
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_EXTENSION,
  })) {
    const hasReachableNeighbour = EIGHT_NEIGHBORS.some(([dx, dy]) =>
      reachable.has(`${cs.pos.x + dx},${cs.pos.y + dy}`),
    );
    if (!hasReachableNeighbour) results.push({ x: cs.pos.x, y: cs.pos.y, built: false });
  }

  return results;
}

function countBuildableLabPositions(
  storageX: number,
  storageY: number,
  terrain: RoomTerrain,
): number {
  const ax = storageX + 2;
  const ay = storageY + 2;
  let count = 0;
  for (const [dx, dy] of LAB_STAMP) {
    const x = ax + dx;
    const y = ay + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) count++;
  }
  return count;
}

function pickStoragePosition(
  liveMap: Map<string, string>,
  spawnPos: RoomPosition,
  terrain: RoomTerrain,
): { x: number; y: number } {
  let bestScore = -1;
  let bestPos: { x: number; y: number } | undefined;

  for (let range = 2; range <= 4; range++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;
        const x = spawnPos.x + dx;
        const y = spawnPos.y + dy;
        if (!inBounds(x, y)) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (!isTileBuildable(liveMap, x, y, STRUCTURE_STORAGE)) continue;
        const score = countBuildableLabPositions(x, y, terrain);
        if (score > bestScore) {
          bestScore = score;
          bestPos = { x, y };
        }
      }
    }
  }

  return bestPos ?? { x: spawnPos.x + 2, y: spawnPos.y };
}

/**
 * Picks up to `cap` tower positions.
 * Live towers (structures + construction sites) are seeded first, sorted by id
 * for deterministic ordering across replans. Additional slots fill from the
 * range-3..6 ring around spawn, maximising mutual Manhattan spread.
 * If liveCount >= cap, returns liveTowers.slice(0, cap) — no crash, no negative count.
 */
function pickTowerPositions(
  room: Room,
  liveMap: Map<string, string>,
  spawnPos: RoomPosition,
  reserved: Set<string>,
  terrain: RoomTerrain,
  cap: number,
): { x: number; y: number }[] {
  // Seed from live towers (structures then sites, each sorted by id for stability)
  const liveTowers = room
    .find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t) => ({ x: t.pos.x, y: t.pos.y }));
  const towerSites = room
    .find(FIND_MY_CONSTRUCTION_SITES, { filter: (s) => s.structureType === STRUCTURE_TOWER })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((s) => ({ x: s.pos.x, y: s.pos.y }));
  const seeded = [...liveTowers, ...towerSites];

  if (seeded.length >= cap) return seeded.slice(0, cap);

  const needed = cap - seeded.length;

  // Candidates: perimeter ring range 3-6, excluding reserved and live non-tower tiles
  const candidates: { x: number; y: number }[] = [];
  for (let range = 3; range <= 6; range++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;
        const x = spawnPos.x + dx;
        const y = spawnPos.y + dy;
        if (!inBounds(x, y)) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (reserved.has(`${x},${y}`)) continue;
        if (!isTileBuildable(liveMap, x, y, STRUCTURE_TOWER)) continue;
        candidates.push({ x, y });
      }
    }
  }

  const chosen: { x: number; y: number }[] = [];
  const remaining = [...candidates];

  while (chosen.length < needed && remaining.length > 0) {
    const allPlaced = [...seeded, ...chosen];
    if (allPlaced.length === 0) {
      chosen.push(remaining.shift()!);
      continue;
    }
    // Maximize minimum Manhattan distance from already-placed towers (live + chosen)
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let j = 0; j < remaining.length; j++) {
      const c = remaining[j]!;
      let minDist = Infinity;
      for (const t of allPlaced) {
        const d = Math.abs(c.x - t.x) + Math.abs(c.y - t.y);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = j;
      }
    }
    chosen.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return [...seeded, ...chosen];
}

export function computeLayout(room: Room): LayoutPlan | undefined {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return undefined;

  const terrain = room.getTerrain();

  // Build once: "x,y" → structureType for all non-rampart live structures + CSes.
  // All picker functions consult this so a replan on a built-up room never places
  // a planned slot on top of an already-built structure of a different type.
  const liveMap = buildLiveMap(room);

  // Step 1: Storage position — use OWN storage so a foreign storage in a reclaimed
  // room doesn't lock the layout plan onto the wrong tile.
  const ownStorageForLayout = myStorage(room);
  const storagePos = ownStorageForLayout
    ? { x: ownStorageForLayout.pos.x, y: ownStorageForLayout.pos.y }
    : pickStoragePosition(liveMap, spawn.pos, terrain);

  const reserved = new Set<string>();
  reserved.add(`${storagePos.x},${storagePos.y}`);
  reserved.add(`${spawn.pos.x},${spawn.pos.y}`);

  // Put live towers and tower CSes into reserved so labs/extensions don't land on them,
  // and so pickTowerPositions's candidate loop doesn't double-pick a seeded tile.
  for (const tower of room.find(FIND_MY_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_TOWER,
  })) {
    reserved.add(`${tower.pos.x},${tower.pos.y}`);
  }
  for (const cs of room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_TOWER,
  })) {
    reserved.add(`${cs.pos.x},${cs.pos.y}`);
  }

  // Step: Spawn positions — seed from live spawns (id-sorted), then pick additional
  // slots up to cap 3 so the construction manager can place 2nd/3rd spawns at RCL 7-8.
  const liveSpawns = room
    .find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_SPAWN })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((s) => ({ x: s.pos.x, y: s.pos.y }));
  const spawnPositions: { x: number; y: number }[] = [...liveSpawns];
  for (const p of liveSpawns) reserved.add(`${p.x},${p.y}`);

  const spawnCap = 3;
  if (spawnPositions.length < spawnCap) {
    const pickedKeys = new Set(spawnPositions.map((p) => `${p.x},${p.y}`));
    const needed = spawnCap - spawnPositions.length;
    const spawnCandidates: { x: number; y: number }[] = [];
    for (let range = 3; range <= 8; range++) {
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;
          const x = spawn.pos.x + dx;
          const y = spawn.pos.y + dy;
          if (!inBounds(x, y)) continue;
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          const key = `${x},${y}`;
          if (reserved.has(key) || pickedKeys.has(key)) continue;
          if (!isTileBuildable(liveMap, x, y, STRUCTURE_SPAWN)) continue;
          spawnCandidates.push({ x, y });
        }
      }
    }
    for (let i = 0; i < needed && i < spawnCandidates.length; i++) {
      const p = spawnCandidates[i]!;
      spawnPositions.push(p);
      reserved.add(`${p.x},${p.y}`);
    }
  }

  // Step 2: Lab positions (anchor = storagePos + (2,2))
  const labAx = storagePos.x + 2;
  const labAy = storagePos.y + 2;
  const labPositions: { x: number; y: number }[] = [];
  let labStampBuildable = 0;

  for (const [dx, dy] of LAB_STAMP) {
    const x = labAx + dx;
    const y = labAy + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    if (reserved.has(`${x},${y}`)) continue;
    if (!isTileBuildable(liveMap, x, y, STRUCTURE_LAB)) continue;
    labStampBuildable++;
    if (!isAccessible(x, y, terrain, liveMap, reserved)) continue; // Prevents the W43N58 corridor-strand bug
    labPositions.push({ x, y });
    reserved.add(`${x},${y}`);
  }

  if (labPositions.length < labStampBuildable) {
    console.log(
      `[layout] ${room.name}: lab stamp can only place ${labPositions.length}/${labStampBuildable} positions due to accessibility constraints`,
    );
  }

  // Step 3: Terminal position — near storage, not in lab area
  let terminalPos: { x: number; y: number } = { x: storagePos.x + 1, y: storagePos.y };
  outerTerminal: for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = storagePos.x + dx;
        const y = storagePos.y + dy;
        if (!inBounds(x, y)) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (reserved.has(`${x},${y}`)) continue;
        if (!isTileBuildable(liveMap, x, y, STRUCTURE_TERMINAL)) continue;
        terminalPos = { x, y };
        reserved.add(`${x},${y}`);
        break outerTerminal;
      }
    }
  }

  // Step 3b: Factory position — adjacent to storage (within 2), prefer next to terminal
  let factoryPos: { x: number; y: number } | undefined;
  outerFactory: for (let r = 1; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = storagePos.x + dx;
        const y = storagePos.y + dy;
        if (!inBounds(x, y)) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (reserved.has(`${x},${y}`)) continue;
        if (!isTileBuildable(liveMap, x, y, STRUCTURE_FACTORY)) continue;
        if (!isAccessible(x, y, terrain, liveMap, reserved)) continue;
        factoryPos = { x, y };
        reserved.add(`${x},${y}`);
        break outerFactory;
      }
    }
  }

  // Step 4: Tower positions — seed from live towers, fill remaining slots spread around spawn
  const towerPositions = pickTowerPositions(room, liveMap, spawn.pos, reserved, terrain, 6);
  for (const t of towerPositions) reserved.add(`${t.x},${t.y}`);

  // Step 4b: Reserve storage access tiles BEFORE extensions so the stamp can't box
  // in the storage. Walks all 8 neighbours (range-1 reach includes diagonals) and
  // reserves up to STORAGE_ACCESS_MIN that are walkable floor — not a wall, not an
  // already-reserved hub structure (terminal/factory/labs/towers), and not a built
  // non-walkable structure. Whatever is already open stays open; extensions skip
  // reserved tiles. (Terminal/factory/labs legitimately consume some neighbours, so
  // this reserves the best of what remains rather than a fixed count.)
  let storageAccessReserved = 0;
  for (const [dx, dy] of EIGHT_NEIGHBORS) {
    if (storageAccessReserved >= STORAGE_ACCESS_MIN) break;
    const x = storagePos.x + dx;
    const y = storagePos.y + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    const key = `${x},${y}`;
    if (reserved.has(key)) continue; // already a hub structure — not an open access tile
    const built = liveMap.get(key);
    if (built && NON_WALKABLE_STRUCTURES.has(built)) continue; // built obstacle — can't be access
    reserved.add(key);
    storageAccessReserved++;
  }

  // Step 4c: Reserve spawn access tiles BEFORE extensions so the stamp can't box
  // in planned spawns. Mirrors the storage reservation above. The primary spawn
  // already has corridors from the stamp's dx=0/dy=0 gap, but secondary spawns
  // (indices 1+) sit in the extension ring and can be sealed on all 8 sides.
  // Reserving for all spawns is harmless (the primary's corridor tiles are already
  // open or reserved by other structures).
  for (const sp of spawnPositions) {
    let spawnAccessReserved = 0;
    for (const [dx, dy] of EIGHT_NEIGHBORS) {
      if (spawnAccessReserved >= SPAWN_ACCESS_MIN) break;
      const x = sp.x + dx;
      const y = sp.y + dy;
      if (!inBounds(x, y)) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      const key = `${x},${y}`;
      if (reserved.has(key)) continue;
      const built = liveMap.get(key);
      if (built && NON_WALKABLE_STRUCTURES.has(built)) continue;
      reserved.add(key);
      spawnAccessReserved++;
    }
  }

  // Step 5: Extension positions — stamp minus reserved and live-blocked, with overflow.
  const extensionPositions: { x: number; y: number }[] = [];
  for (const [dx, dy] of EXTENSION_STAMP) {
    const x = spawn.pos.x + dx;
    const y = spawn.pos.y + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    if (reserved.has(`${x},${y}`)) continue;
    if (!isTileBuildable(liveMap, x, y, STRUCTURE_EXTENSION)) continue;
    extensionPositions.push({ x, y });
  }

  // Overflow to 70 planned slots so road-blocked stamp positions don't leave the plan
  // short. The game only builds up to the RCL cap (40/50/60 at RCL 6/7/8), so extra
  // slots sit unused until needed. Overflow positions land at Chebyshev distance 5+.
  if (extensionPositions.length < 70) {
    const inPlan = new Set(extensionPositions.map((p) => `${p.x},${p.y}`));
    // Treat existing extension construction sites as occupied so the trap check
    // accounts for sites placed by a previous (now-superseded) plan.
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    })) {
      inPlan.add(`${site.pos.x},${site.pos.y}`);
    }
    const cardinalOffsets: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let r = 5; r <= 9 && extensionPositions.length < 70; r++) {
      for (let dx = -r; dx <= r && extensionPositions.length < 70; dx++) {
        for (let dy = -r; dy <= r && extensionPositions.length < 70; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          // Mirror the main stamp: leave dx=0 and dy=0 as road corridor axes.
          if (dx === 0 || dy === 0) continue;
          const x = spawn.pos.x + dx;
          const y = spawn.pos.y + dy;
          if (!inBounds(x, y)) continue;
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          const key = `${x},${y}`;
          if (reserved.has(key) || inPlan.has(key)) continue;
          if (!isTileBuildable(liveMap, x, y, STRUCTURE_EXTENSION)) continue;
          // Don't place if it would leave any planned cardinal neighbour with ≤1
          // open cardinal. Zero means completely inaccessible; one means a single
          // choke-point that other overflow extensions can close. Require ≥2 so
          // the outer stamp ring always retains multiple access directions.
          // Terrain walls count as blocked — a wall-blocked cardinal is not a
          // usable access direction even though it's not in the plan.
          const wouldTrap = cardinalOffsets.some(([ndx, ndy]) => {
            const nk = `${x + ndx},${y + ndy}`;
            if (!inPlan.has(nk)) return false;
            const openAfter = cardinalOffsets.filter(([cdx, cdy]) => {
              const ck = `${x + ndx + cdx},${y + ndy + cdy}`;
              const nx = x + ndx + cdx;
              const ny = y + ndy + cdy;
              return (
                ck !== key &&
                !inPlan.has(ck) &&
                !reserved.has(ck) &&
                terrain.get(nx, ny) !== TERRAIN_MASK_WALL
              );
            }).length;
            return openAfter <= 1;
          });
          if (wouldTrap) continue;
          extensionPositions.push({ x, y });
          inPlan.add(key);
        }
      }
    }
  }

  // Step 6: Flood-fill reachability prune — drop any extension whose 8-neighbours are
  // all unreachable from the spawn over the final planned + built obstacle set.
  // Fixes the W44N57 case where a planned extension's only walkable approach tile was
  // itself a 1-tile pocket sealed by other planned obstacles (local checks passed; the
  // transitive flood catches it). Built non-walkable structures come from liveMap;
  // planned non-walkable come from every fixed position in the layout.
  const plannedObstacleKeys = new Set<string>();
  for (const [key, type] of liveMap.entries()) {
    if (NON_WALKABLE_STRUCTURES.has(type)) plannedObstacleKeys.add(key);
  }
  plannedObstacleKeys.add(`${storagePos.x},${storagePos.y}`);
  plannedObstacleKeys.add(`${spawn.pos.x},${spawn.pos.y}`);
  if (terminalPos) plannedObstacleKeys.add(`${terminalPos.x},${terminalPos.y}`);
  if (factoryPos) plannedObstacleKeys.add(`${factoryPos.x},${factoryPos.y}`);
  for (const p of spawnPositions) plannedObstacleKeys.add(`${p.x},${p.y}`);
  for (const p of labPositions) plannedObstacleKeys.add(`${p.x},${p.y}`);
  for (const p of towerPositions) plannedObstacleKeys.add(`${p.x},${p.y}`);
  for (const p of extensionPositions) plannedObstacleKeys.add(`${p.x},${p.y}`);

  const builtExtensions: { x: number; y: number }[] = [];
  for (const [key, type] of liveMap.entries()) {
    if (type === STRUCTURE_EXTENSION) {
      const [xStr, yStr] = key.split(',');
      builtExtensions.push({ x: Number(xStr), y: Number(yStr) });
    }
  }

  const prunedExtensions = pruneUnreachableExtensions(
    extensionPositions,
    plannedObstacleKeys,
    terrain,
    spawn.pos,
    builtExtensions,
  );

  return {
    version: LAYOUT_PLAN_VERSION,
    storagePos,
    terminalPos,
    factoryPos,
    towerPositions,
    labPositions,
    extensionPositions: prunedExtensions,
    spawnPositions,
  };
}

/**
 * Score a hypothetical spawn position using terrain only (no existing structures).
 * Used for new room claim planning. Returns -1 if the position is unviable.
 *
 * Score = labCount*10 + extensionCount + corridorOpenness*2
 * Minimum viability: labCount >= 3 and extensionCount >= 50.
 */
export function scoreSpawnCandidate(spawnX: number, spawnY: number, terrain: RoomTerrain): number {
  if (!inBounds(spawnX, spawnY)) return -1;
  if (terrain.get(spawnX, spawnY) === TERRAIN_MASK_WALL) return -1;

  // Find best storage position and how many labs it supports
  let bestLabCount = 0;
  let bestStorage: { x: number; y: number } | undefined;
  for (let range = 2; range <= 4; range++) {
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (Math.abs(dx) !== range && Math.abs(dy) !== range) continue;
        const sx = spawnX + dx;
        const sy = spawnY + dy;
        if (!inBounds(sx, sy)) continue;
        if (terrain.get(sx, sy) === TERRAIN_MASK_WALL) continue;
        const labCount = countBuildableLabPositions(sx, sy, terrain);
        if (labCount > bestLabCount) {
          bestLabCount = labCount;
          bestStorage = { x: sx, y: sy };
        }
      }
    }
  }

  if (!bestStorage || bestLabCount < 3) return -1;

  // Count viable extension positions from the stamp
  const reserved = new Set<string>([`${bestStorage.x},${bestStorage.y}`, `${spawnX},${spawnY}`]);
  let extCount = 0;
  for (const [dx, dy] of EXTENSION_STAMP) {
    const x = spawnX + dx;
    const y = spawnY + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    if (reserved.has(`${x},${y}`)) continue;
    extCount++;
  }

  if (extCount < 50) return -1;

  // Count corridor openness: both axes up to range 4 from spawn
  let corridorOpen = 0;
  for (let i = 1; i <= 4; i++) {
    if (inBounds(spawnX, spawnY + i) && terrain.get(spawnX, spawnY + i) !== TERRAIN_MASK_WALL)
      corridorOpen++;
    if (inBounds(spawnX, spawnY - i) && terrain.get(spawnX, spawnY - i) !== TERRAIN_MASK_WALL)
      corridorOpen++;
    if (inBounds(spawnX + i, spawnY) && terrain.get(spawnX + i, spawnY) !== TERRAIN_MASK_WALL)
      corridorOpen++;
    if (inBounds(spawnX - i, spawnY) && terrain.get(spawnX - i, spawnY) !== TERRAIN_MASK_WALL)
      corridorOpen++;
  }

  return bestLabCount * 10 + extCount + corridorOpen * 2;
}

/**
 * Find the best spawn position for a room not yet claimed.
 * Uses stride-2 sampling for speed (still covers all viable spots).
 * Stores the result in RoomMemory.suggestedSpawnPos.
 */
export function findBestSpawnPosition(
  roomName: string,
): { x: number; y: number; score: number } | undefined {
  const terrain = Game.map.getRoomTerrain(roomName);

  let bestScore = -1;
  let bestPos: { x: number; y: number; score: number } | undefined;

  // Stride 2 — fine enough for a stamp footprint that spans 8+ tiles
  for (let x = 5; x <= 44; x += 2) {
    for (let y = 5; y <= 44; y += 2) {
      const score = scoreSpawnCandidate(x, y, terrain);
      if (score > bestScore) {
        bestScore = score;
        bestPos = { x, y, score };
      }
    }
  }

  if (bestPos) {
    const mem = (Memory.rooms[roomName] ??= {});
    mem.suggestedSpawnPos = bestPos;
  }

  return bestPos;
}
