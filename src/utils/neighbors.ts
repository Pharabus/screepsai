/**
 * Persistent hostile player intel across ticks and global resets.
 *
 * Stored in RawMemory segment 5 so it doesn't bloat the main Memory blob.
 * Tracks which players have attacked, their body compositions, and whether
 * they are classified as aggressive — used by the remote planner to avoid
 * setting up remotes near persistent harassers.
 */

import { getSegment, setSegment, requestSegment } from './segments';
import { threatScore } from './threat';

const SEGMENT_NEIGHBORS = 5;

export type NeighborHostility = 'unknown' | 'passive' | 'aggressive';

export interface NeighborRecord {
  firstSeen: number;
  lastSeen: number;
  /** Number of ticks we observed this player with threat-scoring creeps in our rooms */
  attacks: number;
  seenRooms: string[];
  maxThreatScore: number;
  /** Histogram of body-part signatures seen (e.g. "ATTACK,HEAL,MOVE" → count) */
  bodies: Record<string, number>;
  hostility: NeighborHostility;
}

type NeighborStore = Record<string, NeighborRecord>;

function loadStore(): NeighborStore {
  return getSegment<NeighborStore>(SEGMENT_NEIGHBORS) ?? {};
}

function saveStore(store: NeighborStore): void {
  setSegment(SEGMENT_NEIGHBORS, store);
}

/** Call at the end of runDefense each tick so the segment stays warm. */
export function requestNeighborSegment(): void {
  requestSegment(SEGMENT_NEIGHBORS);
}

function bodySignature(creep: Creep): string {
  const types = new Set<string>();
  for (const part of creep.body) {
    if (part.hits > 0) types.add(part.type);
  }
  return [...types].sort().join(',');
}

function classifyHostility(rec: NeighborRecord): NeighborHostility {
  if (rec.attacks === 0) return 'passive';
  // Repeated attacks or a high-threat squad always flags aggressive
  if (rec.attacks >= 3 || rec.maxThreatScore >= 500) return 'aggressive';
  // Single low-threat sighting is probably an invader scout
  if (rec.maxThreatScore < 200) return 'passive';
  return 'unknown';
}

/**
 * Record a hostile creep sighting. Call once per hostile per tick from runDefense.
 */
export function recordHostile(creep: Creep, room: Room): void {
  if (!creep.owner?.username) return;
  const name = creep.owner.username;
  const store = loadStore();

  const existing = store[name];
  const score = threatScore(creep);
  const sig = bodySignature(creep);

  if (!existing) {
    const rec: NeighborRecord = {
      firstSeen: Game.time,
      lastSeen: Game.time,
      attacks: score > 0 ? 1 : 0,
      seenRooms: [room.name],
      maxThreatScore: score,
      bodies: { [sig]: 1 },
      hostility: score > 0 ? 'unknown' : 'passive',
    };
    rec.hostility = classifyHostility(rec);
    store[name] = rec;
  } else {
    existing.lastSeen = Game.time;
    if (score > 0) existing.attacks++;
    if (!existing.seenRooms.includes(room.name)) existing.seenRooms.push(room.name);
    if (score > existing.maxThreatScore) existing.maxThreatScore = score;
    existing.bodies[sig] = (existing.bodies[sig] ?? 0) + 1;
    existing.hostility = classifyHostility(existing);
  }

  saveStore(store);
}

export function getNeighbor(playerName: string): NeighborRecord | undefined {
  return loadStore()[playerName];
}

/** Returns true if any known aggressive neighbor was seen within the last maxAge ticks. */
export function hasAggressiveNeighbor(maxAgeTicks = 20_000): boolean {
  const store = loadStore();
  for (const rec of Object.values(store)) {
    if (rec.hostility === 'aggressive' && Game.time - rec.lastSeen <= maxAgeTicks) return true;
  }
  return false;
}

/** Returns player names seen recently in a specific room. */
export function hostilesSeen(roomName: string, maxAgeTicks = 20_000): string[] {
  const store = loadStore();
  return Object.entries(store)
    .filter(
      ([, rec]) => rec.seenRooms.includes(roomName) && Game.time - rec.lastSeen <= maxAgeTicks,
    )
    .map(([name]) => name);
}

export function summarizeNeighbors(): string {
  const store = loadStore();
  const entries = Object.entries(store);
  if (entries.length === 0) return '[neighbors] No hostile players recorded.';

  const lines = entries
    .sort(([, a], [, b]) => b.lastSeen - a.lastSeen)
    .map(([name, rec]) => {
      const age = Game.time - rec.lastSeen;
      return `  ${name}: ${rec.hostility} | attacks=${rec.attacks} maxThreat=${rec.maxThreatScore} lastSeen=${age}t ago rooms=[${rec.seenRooms.join(',')}]`;
    });
  return '[neighbors]\n' + lines.join('\n');
}
