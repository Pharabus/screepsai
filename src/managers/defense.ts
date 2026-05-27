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
import { getStructuresByType } from '../utils/tickCache';
import { logCombat } from '../utils/combatLog';

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

// Threat score one energised tower can handle on its own. A lone invader
// (~260) sits well under this, so a single tower solos it with no defender.
const THREAT_PER_TOWER = 500;

// Conservative per-tower damage/tick estimate (HP) for the heal comparison —
// mid-range between optimal 600 (range <=5) and 150 (range >=20).
const TOWER_DPS_ESTIMATE = 300;

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

function tryActivateSafeMode(room: Room, mem: RoomMemory): void {
  const c = room.controller;
  if (!c?.my) return;
  if (c.safeMode) return; // already active
  if (!hostileNearCriticalStructure(room)) return;

  // Can't activate — log once per combat so we know we were overrun without a fallback.
  if (
    !c.safeModeAvailable ||
    c.safeModeAvailable <= 0 ||
    (c.safeModeCooldown && c.safeModeCooldown > 0)
  ) {
    if (!mem.combatSafeModeLogged) {
      mem.combatSafeModeLogged = true;
      const reason =
        !c.safeModeAvailable || c.safeModeAvailable <= 0
          ? 'no charges remaining'
          : `cooldown ${c.safeModeCooldown} ticks`;
      logCombat({
        tick: Game.time,
        room: room.name,
        event: 'safe_mode_unavailable',
        safeModesLeft: c.safeModeAvailable ?? 0,
        details: reason,
      });
    }
    return;
  }

  const result = c.activateSafeMode();
  if (result === OK) {
    logCombat({
      tick: Game.time,
      room: room.name,
      event: 'safe_mode_activated',
      safeModesLeft: (c.safeModeAvailable ?? 1) - 1,
    });
    console.log(`[defense] ${room.name}: safe mode activated`);
  } else {
    console.log(`[defense] ${room.name}: safe mode activation failed (${result})`);
  }
}

export function runDefense(): void {
  for (const room of Object.values(Game.rooms)) {
    const mem = (Memory.rooms[room.name] ??= {});
    const hostiles = room.find(FIND_HOSTILE_CREEPS);

    // Track NPC Invader presence in every visible room so the spawner can
    // queue hunters for remote/transit rooms regardless of who owns them.
    const hasInvaderNpc = hostiles.some((c) => c.owner?.username === 'Invader');
    if (hasInvaderNpc) {
      mem.invaderSeenAt = Game.time;
    } else {
      // Visibility confirmed clear — remove the flag so the hunter stands down.
      delete mem.invaderSeenAt;
    }

    if (!room.controller?.my) continue;

    const threat = hostiles.reduce((sum, h) => sum + threatScore(h), 0);
    const hasActiveThreat = threat > 0 || hostiles.length > 0;

    if (hasActiveThreat) {
      mem.threatLastSeen = Game.time;
      mem.lastThreatScore = threat;

      if (!mem.combatActive) {
        // First tick of a new attack — open a combat record.
        mem.combatActive = true;
        mem.combatSafeModeLogged = false;
        mem.combatTowerDrainLogged = false;
        const owners = [
          ...new Set(hostiles.flatMap((h) => (h.owner?.username ? [h.owner.username] : []))),
        ];
        logCombat({
          tick: Game.time,
          room: room.name,
          event: 'threat_appeared',
          threatScore: threat,
          hostileCount: hostiles.length,
          owners,
        });
      }
    } else if (mem.combatActive) {
      // All hostiles gone this tick — close the combat record.
      mem.combatActive = false;
      mem.combatSafeModeLogged = false;
      mem.combatTowerDrainLogged = false;
      const duration = mem.threatLastSeen ? Game.time - mem.threatLastSeen : 0;
      logCombat({
        tick: Game.time,
        room: room.name,
        event: 'threat_ended',
        details: `combat lasted ~${duration} ticks`,
      });
    }

    for (const h of hostiles) {
      if (h.owner?.username) recordHostile(h, room);
    }

    requestNeighborSegment();
    tryActivateSafeMode(room, mem);
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

  // Towers fire every tick on their own. If the room has energised towers whose
  // combined capacity covers this threat — AND the enemy can't out-heal their
  // fire — skip defenders entirely. Safe mode remains the backstop for a real
  // breach, and towers keep firing regardless.
  const towers = (
    (getStructuresByType(room)[STRUCTURE_TOWER] as StructureTower[] | undefined) ?? []
  ).filter((t) => t.my && t.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST);
  if (towers.length > 0 && threat <= towers.length * THREAT_PER_TOWER) {
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const hostileHeal = hostiles.reduce(
      (sum, h) => sum + h.body.filter((p) => p.type === HEAL && p.hits > 0).length * HEAL_POWER,
      0,
    );
    const enemyOutHealsTowers = hostileHeal >= towers.length * TOWER_DPS_ESTIMATE;
    if (!enemyOutHealsTowers) return 0; // towers solo it
  }

  const n = Math.ceil(threat / THREAT_PER_DEFENDER);
  return Math.min(n, MAX_DEFENDERS_PER_ROOM);
}
