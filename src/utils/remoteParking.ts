import { nameHash } from './idle';

const MIN_RANGE = 2;
const MAX_RANGE = 5;
// A tile with fewer open neighbours than this is part of a corridor or pocket
// (live W41N58: the lane tiles at x20,y2-3 have 2). Parked creeps there block
// everything that has to pass, so they are never used.
const MIN_OPEN_NEIGHBOURS = 6;

/**
 * Picks a tile for an idle remote hauler to wait on: near the source so it is
 * ready when energy appears, but never on a road, container or other structure,
 * and never in a corridor. Deterministic per creep name so a group of idle
 * haulers spreads over different tiles instead of stacking.
 *
 * Returns undefined when no tile qualifies (caller keeps its old behaviour).
 */
export function pickRemoteParkingTile(
  room: Room,
  source: { x: number; y: number },
  creepName: string,
): { x: number; y: number } | undefined {
  const terrain = room.getTerrain();
  const blocked = new Set<number>();
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_RAMPART) continue;
    blocked.add(s.pos.y * 50 + s.pos.x);
  }

  const open = (x: number, y: number): boolean =>
    x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;

  const candidates: { x: number; y: number }[] = [];
  for (let dy = -MAX_RANGE; dy <= MAX_RANGE; dy++) {
    for (let dx = -MAX_RANGE; dx <= MAX_RANGE; dx++) {
      const range = Math.max(Math.abs(dx), Math.abs(dy));
      if (range < MIN_RANGE) continue;
      const x = source.x + dx;
      const y = source.y + dy;
      if (!open(x, y) || blocked.has(y * 50 + x)) continue;
      let neighbours = 0;
      for (let ny = -1; ny <= 1; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          if ((nx || ny) && open(x + nx, y + ny)) neighbours++;
        }
      }
      if (neighbours >= MIN_OPEN_NEIGHBOURS) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return undefined;
  return candidates[nameHash(creepName) % candidates.length];
}
