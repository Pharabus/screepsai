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
  room: Room,
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
        const pos = new RoomPosition(x, y, room.name);
        const blocked =
          pos.lookFor(LOOK_STRUCTURES).length > 0 ||
          pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
        if (blocked) continue;
        const score = countBuildableLabPositions(x, y, terrain);
        // Prefer higher lab coverage, break ties by range (closer is better)
        if (score > bestScore) {
          bestScore = score;
          bestPos = { x, y };
        }
      }
    }
  }

  return bestPos ?? { x: spawnPos.x + 2, y: spawnPos.y };
}

function pickTowerPositions(
  spawnPos: RoomPosition,
  reserved: Set<string>,
  terrain: RoomTerrain,
  count: number,
): { x: number; y: number }[] {
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
        candidates.push({ x, y });
      }
    }
  }

  const chosen: { x: number; y: number }[] = [];
  const remaining = [...candidates];

  while (chosen.length < count && remaining.length > 0) {
    if (chosen.length === 0) {
      // First tower: just take first candidate (range 3, arbitrary direction)
      chosen.push(remaining.shift()!);
      continue;
    }

    // Subsequent: maximize minimum Manhattan distance from already-placed towers
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let j = 0; j < remaining.length; j++) {
      const c = remaining[j]!;
      let minDist = Infinity;
      for (const t of chosen) {
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

  return chosen;
}

export function computeLayout(room: Room): LayoutPlan | undefined {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return undefined;

  const terrain = room.getTerrain();

  // Step 1: Storage position
  const storagePos = room.storage
    ? { x: room.storage.pos.x, y: room.storage.pos.y }
    : pickStoragePosition(room, spawn.pos, terrain);

  const reserved = new Set<string>();
  reserved.add(`${storagePos.x},${storagePos.y}`);
  reserved.add(`${spawn.pos.x},${spawn.pos.y}`);

  // Step 2: Lab positions (anchor = storagePos + (2,2))
  const labAx = storagePos.x + 2;
  const labAy = storagePos.y + 2;
  const labPositions: { x: number; y: number }[] = [];

  for (const [dx, dy] of LAB_STAMP) {
    const x = labAx + dx;
    const y = labAy + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
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
        terminalPos = { x, y };
        reserved.add(`${x},${y}`);
        break outerTerminal;
      }
    }
  }

  // Step 4: Tower positions — spread around spawn perimeter
  const towerPositions = pickTowerPositions(spawn.pos, reserved, terrain, 6);
  for (const t of towerPositions) reserved.add(`${t.x},${t.y}`);

  // Step 5: Extension positions — stamp minus reserved, with overflow
  const extensionPositions: { x: number; y: number }[] = [];
  for (const [dx, dy] of EXTENSION_STAMP) {
    const x = spawn.pos.x + dx;
    const y = spawn.pos.y + dy;
    if (!inBounds(x, y)) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    if (reserved.has(`${x},${y}`)) continue;
    extensionPositions.push({ x, y });
  }

  // Overflow positions if stamp was insufficient (reserved positions ate slots)
  if (extensionPositions.length < 60) {
    const inPlan = new Set(extensionPositions.map((p) => `${p.x},${p.y}`));
    for (let r = 5; r <= 9 && extensionPositions.length < 60; r++) {
      for (let dx = -r; dx <= r && extensionPositions.length < 60; dx++) {
        for (let dy = -r; dy <= r && extensionPositions.length < 60; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = spawn.pos.x + dx;
          const y = spawn.pos.y + dy;
          if (!inBounds(x, y)) continue;
          if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
          const key = `${x},${y}`;
          if (reserved.has(key) || inPlan.has(key)) continue;
          extensionPositions.push({ x, y });
          inPlan.add(key);
        }
      }
    }
  }

  // Warn about lab positions occupied by existing structures (e.g. misplaced extensions)
  const blockedLabs: string[] = [];
  for (const pos of labPositions) {
    const rp = new RoomPosition(pos.x, pos.y, room.name);
    const blocking = rp
      .lookFor(LOOK_STRUCTURES)
      .filter((s) => s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_ROAD);
    if (blocking.length > 0) {
      blockedLabs.push(`(${pos.x},${pos.y}:${blocking[0]!.structureType})`);
    }
  }
  if (blockedLabs.length > 0) {
    console.log(
      `[layout] ${room.name}: ${blockedLabs.length} lab position(s) blocked — consider demolishing: ${blockedLabs.join(', ')}`,
    );
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
