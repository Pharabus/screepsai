/**
 * Transient per-tick cache.
 *
 * Screeps parses Memory from a JSON blob on first access each tick; room.find /
 * findClosestByRange / pathfinding are also repeated across managers. This
 * cache lets unrelated modules share the result of an expensive call within a
 * single tick without going back to Memory or re-scanning the room. It is
 * cleared at the start of every loop and does not touch Memory or RawMemory.
 */

// Wrap values in a sentinel object so that `undefined` is a storable result.
// The previous `hit !== undefined` check caused compute() to re-run whenever
// it legitimately returned undefined — e.g. getMyUsername() when no spawns exist.
interface CacheEntry {
  value: unknown;
}

let cache = new Map<string, CacheEntry>();

export function resetTickCache(): void {
  cache = new Map();
}

export function cached<T>(key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit.value as T;
  const value = compute();
  cache.set(key, { value });
  return value;
}

export function invalidate(key: string): void {
  cache.delete(key);
}

/**
 * Returns all structures in the room grouped by structureType, cached for the
 * current tick. Callers use `result[STRUCTURE_X] ?? []` instead of a per-call
 * `room.find(FIND_STRUCTURES, { filter: s => s.structureType === X })`.
 */
export function getStructuresByType(room: Room): Partial<Record<StructureConstant, Structure[]>> {
  return cached(`${room.name}:structsByType`, () => {
    const m: Partial<Record<StructureConstant, Structure[]>> = {};
    for (const s of room.find(FIND_STRUCTURES)) {
      (m[s.structureType] ??= []).push(s);
    }
    return m;
  });
}

/**
 * Returns all MY construction sites in the room grouped by structureType,
 * cached for the current tick. Mirrors getStructuresByType's shape.
 * Callers use `result[STRUCTURE_X] ?? []` instead of a per-call
 * `room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === X })`.
 */
export function getMySitesByType(
  room: Room,
): Partial<Record<BuildableStructureConstant, ConstructionSite[]>> {
  return cached(`${room.name}:mySitesByType`, () => {
    const m: Partial<Record<BuildableStructureConstant, ConstructionSite[]>> = {};
    for (const s of room.find(FIND_MY_CONSTRUCTION_SITES)) {
      (m[s.structureType] ??= []).push(s);
    }
    return m;
  });
}

/**
 * Returns MY (owned) structures in the room grouped by structureType, cached
 * for the current tick. Unlike getStructuresByType (FIND_STRUCTURES), this uses
 * FIND_MY_STRUCTURES so it naturally excludes foreign-owned structures in
 * reclaimed rooms (previous owner's spawns, extensions, towers, etc.).
 * Callers use `result[STRUCTURE_X] ?? []` instead of a per-call
 * `room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === X })`.
 */
export function getMyStructuresByType(room: Room): Partial<Record<StructureConstant, Structure[]>> {
  return cached(`${room.name}:myStructsByType`, () => {
    const m: Partial<Record<StructureConstant, Structure[]>> = {};
    for (const s of room.find(FIND_MY_STRUCTURES)) {
      (m[s.structureType] ??= []).push(s);
    }
    return m;
  });
}
