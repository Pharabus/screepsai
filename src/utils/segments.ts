/**
 * Typed wrapper over RawMemory.segments.
 *
 * Screeps exposes 100 raw-memory segments of up to 100KB each, of which at most
 * 10 can be active in a given tick. Segments bypass the main Memory blob, so
 * moving large / cold data (room plans, scout reports, stats) into them keeps
 * the per-tick JSON.parse of Memory cheap.
 *
 * Workflow:
 *   1. Call `requestSegment(id)` on any tick you *might* need a segment next
 *      tick — the engine will load it and make the raw string available.
 *   2. Call `getSegment(id)` to read + parse lazily (parses once per tick, on
 *      first access).
 *   3. Call `setSegment(id, value)` to stage a write; the serialized string is
 *      only written back to RawMemory.segments at `flushSegments()` time, and
 *      only for segments that were actually mutated.
 *
 * Reads for segments that were not requested on the previous tick return
 * undefined — call `requestSegment` and try again next tick.
 */

const MAX_ACTIVE_SEGMENTS = 10;

// Parsed values keyed by segment id. Populated lazily on first read per tick.
const parsed = new Map<number, unknown>();

// Segment ids whose in-memory value has been mutated and needs to be written
// back at flush time.
const dirty = new Set<number>();

// Segment ids requested for the *next* tick. Accumulated during the tick and
// handed to RawMemory.setActiveSegments at flush time.
const requested = new Set<number>();

// Segment ids whose parsed cache should be discarded at the next tick boundary
// (global didn't reset but we want a fresh read).
let tickStamp = -1;

function resetIfNewTick(): void {
  if (Game.time !== tickStamp) {
    tickStamp = Game.time;
    parsed.clear();
    dirty.clear();
    requested.clear();
  }
}

export function requestSegment(id: number): void {
  resetIfNewTick();
  requested.add(id);
}

export function getSegment<T = unknown>(id: number): T | undefined {
  resetIfNewTick();
  if (parsed.has(id)) return parsed.get(id) as T;

  const raw = RawMemory.segments[id];
  if (raw === undefined) return undefined;

  if (raw === '') {
    parsed.set(id, undefined);
    return undefined;
  }

  try {
    const value = JSON.parse(raw) as T;
    parsed.set(id, value);
    return value;
  } catch (e) {
    console.log(`segments: failed to parse segment ${id}: ${String(e)}`);
    parsed.set(id, undefined);
    return undefined;
  }
}

export function setSegment<T>(id: number, value: T): void {
  resetIfNewTick();
  parsed.set(id, value);
  dirty.add(id);
}

/**
 * Serialize dirty segments and register requested segments for the next tick.
 * Call once at the end of the main loop.
 */
export function flushSegments(): void {
  for (const id of dirty) {
    const value = parsed.get(id);
    RawMemory.segments[id] = value === undefined ? '' : JSON.stringify(value);
  }
  dirty.clear();

  if (requested.size > 0) {
    const ids = [...requested].slice(0, MAX_ACTIVE_SEGMENTS);
    RawMemory.setActiveSegments(ids);
  }
}
