/**
 * Defense orchestrator.
 *
 * Runs before towers each tick. Responsibilities:
 *   - Detect hostiles in every owned room and cache threat state.
 *   - Auto-activate safe mode when a hostile gets close to critical
 *     infrastructure (spawn/controller/storage) and safe mode is available.
 *   - Expose `defendersNeeded(room)` so the spawner can reactively produce
 *     `defender` creeps.
 *
 * Tower focus-fire lives in `managers/towers.ts`; this manager owns the
 * strategic decisions (safe mode, spawn pressure) and shared threat state.
 */

import { threatScore } from '../utils/threat';
import { recordHostile, requestNeighborSegment } from '../utils/neighbors';

// Hostile is treated as inside the base perimeter when within this range of
// a spawn, storage, or the controller.
const CRITICAL_RANGE = 5;

// How many ticks after the last hostile sighting we still spawn defenders —
// avoids cancelling a defender mid-way through spawning because the attacker
// briefly stepped out of view.
const THREAT_MEMORY_TICKS = 50;

// How much hostile threat score one defender covers, roughly.
const THREAT_PER_DEFENDER = 200;

const MAX_DEFENDERS_PER_ROOM = 4;

function hostileNearCriticalStructure(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS, {
    filter: (c) => threatScore(c) > 0,
  });
  if (hostiles.length === 0) return false;

  const targets: RoomPosition[] = [];
  for (const s of room.find(FIND_MY_SPAWNS)) targets.push(s.pos);
  const storage = room.storage;
  if (storage) targets.push(storage.pos);
  if (room.controller?.my) targets.push(room.controller.pos);

  for (const h of hostiles) {
    for (const pos of targets) {
      if (h.pos.inRangeTo(pos, CRITICAL_RANGE)) return true;
    }
  }
  return false;
}

function tryActivateSafeMode(room: Room): void {
  const c = room.controller;
  if (!c?.my) return;
  if (c.safeMode) return; // already active
  if (!c.safeModeAvailable || c.safeModeAvailable <= 0) return;
  if (c.safeModeCooldown && c.safeModeCooldown > 0) return;
  if (!hostileNearCriticalStructure(room)) return;

  const result = c.activateSafeMode();
  if (result === OK) {
    console.log(`[defense] ${room.name}: safe mode activated`);
  } else {
    console.log(`[defense] ${room.name}: safe mode activation failed (${result})`);
  }
}

export function runDefense(): void {
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    const mem = (Memory.rooms[room.name] ??= {});

    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const threat = hostiles.reduce((sum, h) => sum + threatScore(h), 0);
    if (threat > 0 || hostiles.length > 0) {
      mem.threatLastSeen = Game.time;
      mem.lastThreatScore = threat;
    }

    for (const h of hostiles) {
      if (h.owner?.username) recordHostile(h, room);
    }

    requestNeighborSegment();
    tryActivateSafeMode(room);
  }
}

/**
 * How many defenders the spawner should aim to have alive in this room right
 * now. Returns 0 when there's been no hostile activity within the memory
 * window.
 */
export function defendersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.threatLastSeen) return 0;
  if (Game.time - mem.threatLastSeen > THREAT_MEMORY_TICKS) return 0;

  const threat = mem.lastThreatScore ?? 0;
  if (threat <= 0) return 0;

  const n = Math.ceil(threat / THREAT_PER_DEFENDER);
  return Math.min(n, MAX_DEFENDERS_PER_ROOM);
}
