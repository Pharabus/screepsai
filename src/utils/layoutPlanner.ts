// Lab stamp: [dx, dy] offsets from lab anchor = storagePos + (2,2).
// Positions 0-1 are input labs; 2-9 are output labs.
export const LAB_STAMP: [number, number][] = [
  [0, 0], // input 1
  [1, 1], // input 2
  [0, 1], // output (RCL 6: 3 labs)
  [1, 0], // output (RCL 7: +3)
  [2, 1],
  [1, 2],
  [2, 0], // output (RCL 8: +4)
  [0, 2],
  [2, 2],
  [-1, 1],
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

export interface LayoutPlan {
  storagePos: { x: number; y: number };
  terminalPos: { x: number; y: number };
  towerPositions: { x: number; y: number }[];
  labPositions: { x: number; y: number }[];
  extensionPositions: { x: number; y: number }[];
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

  // Step 1: Storage position
  const storagePos = room.storage
    ? { x: room.storage.pos.x, y: room.storage.pos.y }
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

  // Step 2: Lab positions (anchor = storagePos + (2,2))
  const labAx = storagePos.x + 2;
  const labAy = storagePos.y + 2;
  const labPositions: { x: number; y: number }[] = [];

  for (const [dx, dy] of LAB_STAMP) {
    const x = labAx + dx;
    const y = labAy + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    if (!isTileBuildable(liveMap, x, y, STRUCTURE_LAB)) continue;
    labPositions.push({ x, y });
    reserved.add(`${x},${y}`);
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

  // Step 4: Tower positions — seed from live towers, fill remaining slots spread around spawn
  const towerPositions = pickTowerPositions(room, liveMap, spawn.pos, reserved, terrain, 6);
  for (const t of towerPositions) reserved.add(`${t.x},${t.y}`);

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

  return { storagePos, terminalPos, towerPositions, labPositions, extensionPositions };
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
