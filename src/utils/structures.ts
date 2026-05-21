/**
 * Heap-cached wrapper for structure.isActive().
 *
 * isActive() costs ~0.2 CPU per call. It only changes when RCL drops or a
 * structure is demolished — both rare. A 500-tick cache makes it effectively
 * free in steady state. The Map lives in module scope (survives across ticks
 * until global reset); on global reset the first call per structure pays one
 * isActive() call, then the cache takes over.
 */

interface OperationalEntry {
  result: boolean;
  cachedAt: number;
}

const operationalCache = new Map<string, OperationalEntry>();
const OPERATIONAL_TTL = 500;

export function isOperational(structure: Structure): boolean {
  const entry = operationalCache.get(structure.id);
  if (entry && Game.time - entry.cachedAt < OPERATIONAL_TTL) {
    return entry.result;
  }
  const result = structure.isActive();
  operationalCache.set(structure.id, { result, cachedAt: Game.time });
  return result;
}

export function clearOperational(id: string): void {
  operationalCache.delete(id);
}
