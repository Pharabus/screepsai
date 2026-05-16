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
