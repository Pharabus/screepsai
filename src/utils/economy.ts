/**
 * Holistic energy-economy model (behind Memory.holisticEconomy dark-deploy flag).
 *
 * Single source of truth for energy availability, upgrade capacity, and wall
 * maintenance targets. All reads are owner-agnostic (myStorage / myTerminal)
 * so a reclaimed room's foreign store is never counted as our budget.
 *
 * The budget is memoised per room per tick via cached() so spawner / towers /
 * factory / terminal all share one computation with no redundant store reads.
 *
 * INVARIANT: upgradeBuffer[8] = 100k < FACTORY_ENERGY_FLOOR = 120k — the
 * factory only compresses batteries from genuine post-upgrade surplus, even
 * under the continuous upgrader formula.
 */

import { cached } from './tickCache';
import { myStorage, myTerminal } from './ownership';
import { FACTORY_ENERGY_FLOOR } from './thresholds';

// ---------------------------------------------------------------------------
// Wall constants (co-located here; towers.ts keeps its own copies for the
// flag-off path so existing behaviour is never changed by this module).
// ---------------------------------------------------------------------------

/** Hard upper limit on rampart/wall HP per RCL — unchanged from towers.ts. */
export const WALL_CAPS: Record<number, number> = {
  3: 10_000,
  4: 50_000,
  5: 300_000,
  6: 1_000_000,
  7: 5_000_000,
  8: 50_000_000,
};

/**
 * Moderate-middle hard floor: lower than the old towers.ts WALL_FLOOR
 * (~half), so a lean room holds a meaningful but much cheaper target and
 * storage can climb to the mineral window. Rich rooms scale above via surplus.
 *
 * Old WALL_FLOOR vs new WALL_HARD_FLOOR:
 *   RCL5: 150k → 100k   RCL6: 300k → 150k   RCL7: 1M → 400k   RCL8: 5M → 2M
 */
export const WALL_HARD_FLOOR: Record<number, number> = {
  3: 10_000,
  4: 30_000,
  5: 100_000,
  6: 150_000,
  7: 400_000,
  8: 2_000_000,
};

// ---------------------------------------------------------------------------
// Economy constants
// ---------------------------------------------------------------------------

/**
 * Hivemind-style energy reserve held back before discretionary spending.
 * Calibrated so RCL8 buffer (100k) < FACTORY_ENERGY_FLOOR (120k) — the
 * factory invariant is preserved under the continuous upgrader formula.
 */
export const UPGRADE_BUFFER: Record<number, number> = {
  5: 10_000,
  6: 25_000,
  7: 50_000,
  8: 100_000,
};

/**
 * Surplus energy that justifies one additional WORK unit of upgrader output.
 * Set to 5k so the continuous formula lands near the old 1/2/3/4 tier
 * behaviour at typical storage levels but without step-function cliffs.
 *
 * Calibration (RCL7, buffer=50k, 15-WORK upgrader body at energyCap≥2300):
 *   colonyEnergy=100k → surplus=50k  → power=11 → n=ceil(11/15)=1
 *   colonyEnergy=150k → surplus=100k → power=21 → n=ceil(21/15)=2
 *   colonyEnergy=250k → surplus=200k → power=41 → n=ceil(41/15)=3
 *   colonyEnergy=400k → surplus=350k → power=71 → n=ceil(71/15)=5→clamp→4
 */
export const ENERGY_PER_UPGRADE_WORK = 5_000;

/**
 * Headroom above the RCL buffer before mineral mining is unlocked.
 * Deliberately different from any upgrader threshold so the collision
 * (mining gate == upgrader tier) can never recur structurally.
 *
 * Gate: total > buffer + MINERAL_RESERVE_MARGIN
 *   RCL6: total > 25k + 15k = 40k  (vs old 50k storage gate == 2nd-upgrader gate)
 *   RCL7: total > 50k + 15k = 65k  (vs old 70k storage gate)
 */
export const MINERAL_RESERVE_MARGIN = 15_000;

/** Overmind-style threshold above which a room is considered saturated and
 *  upgrade power is doubled to accelerate RCL8 progress. */
export const SATURATED_THRESHOLD = 500_000;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Combined energy the colony can access: own storage + own terminal.
 * Owner-agnostic: foreign storage/terminal (reclaimed rooms) are excluded.
 */
export function colonyEnergy(room: Room): number {
  const storageE = myStorage(room)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const terminalE = myTerminal(room)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  return storageE + terminalE;
}

/** RCL-keyed energy buffer (reserve held before discretionary spending). */
export function upgradeBuffer(room: Room): number {
  const rcl = room.controller?.level ?? 0;
  return UPGRADE_BUFFER[rcl] ?? 10_000;
}

// ---------------------------------------------------------------------------
// Economy stage
// ---------------------------------------------------------------------------

export type EconomyStage = 'bootstrap' | 'growth' | 'mature' | 'saturated';

/**
 * Classify the room's economy phase.
 *
 * - bootstrap  — no miner economy yet (harvester phase); conservative spending.
 * - growth     — miner economy active but RCL < 6; aggressive investment.
 * - mature     — RCL 6+, normal operation.
 * - saturated  — total reserves ≥ SATURATED_THRESHOLD; double upgrade output.
 */
export function economyStage(room: Room): EconomyStage {
  const mem = Memory.rooms[room.name];
  if (!mem?.minerEconomy) return 'bootstrap';
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return 'growth';
  const total = colonyEnergy(room);
  if (total >= SATURATED_THRESHOLD) return 'saturated';
  return 'mature';
}

// ---------------------------------------------------------------------------
// Upgrader body / power helpers
// ---------------------------------------------------------------------------

/**
 * WORK parts in the upgrader body that would be spawned right now.
 *
 * Mirrors the upgraderEnergyCap ladder in spawner.ts so count and body stay
 * consistent. Uses myStorage energy (NOT colonyEnergy) for the cap tier —
 * body size is governed by how much storage the room currently holds, while
 * surplus (colonyEnergy - buffer) determines how MANY upgraders to run.
 */
export function upgraderWorkParts(room: Room): number {
  const stored = myStorage(room)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const rcl = room.controller?.level ?? 0;
  const isYoung = rcl < 6;

  let cap: number;
  if (isYoung) {
    cap = stored < 5_000 ? 600 : stored < 15_000 ? 1_100 : room.energyCapacityAvailable;
  } else {
    cap = stored < 15_000 ? 600 : stored < 50_000 ? 1_100 : room.energyCapacityAvailable;
  }
  cap = Math.min(cap, room.energyCapacityAvailable);
  // buildUpgraderBody: workCount = min(floor((cap - 100) / 100), 15)
  return Math.min(Math.floor((cap - 100) / 100), 15);
}

/**
 * Target total WORK output across all upgraders.
 *
 * Continuous formula (no cliffs): 1 extra WORK per ENERGY_PER_UPGRADE_WORK
 * surplus above the RCL buffer. Doubled in saturated stage to flush excess.
 */
export function upgradePower(room: Room): number {
  const buffer = upgradeBuffer(room);
  const total = colonyEnergy(room);
  const surplus = Math.max(0, total - buffer);
  let power = 1 + Math.floor(surplus / ENERGY_PER_UPGRADE_WORK);
  if (economyStage(room) === 'saturated') power *= 2;
  return power;
}

// ---------------------------------------------------------------------------
// Wall target
// ---------------------------------------------------------------------------

/**
 * Target HP for ramparts/walls (moderate-middle posture).
 *
 * Lean room (surplus=0): holds at the lower WALL_HARD_FLOOR so storage can
 * climb to the mineral window. Rich room: scales above the floor from genuine
 * surplus. Clamped to the per-RCL cap.
 *
 *   wallHpTarget = clamp(WALL_HARD_FLOOR + floor(surplus * 0.5), floor, cap)
 */
export function wallHpTarget(room: Room): number {
  const rcl = room.controller?.level ?? 0;
  const cap = WALL_CAPS[rcl] ?? 10_000;
  const floor = WALL_HARD_FLOOR[rcl] ?? 10_000;
  const buffer = upgradeBuffer(room);
  const total = colonyEnergy(room);
  const surplus = Math.max(0, total - buffer);
  return Math.min(floor + Math.floor(surplus * 0.5), cap);
}

// ---------------------------------------------------------------------------
// Budget (cached, single computation shared across all consumers)
// ---------------------------------------------------------------------------

export interface EnergyBudget {
  stage: EconomyStage;
  /** Combined storage + terminal energy (owner-agnostic). */
  total: number;
  /** RCL-keyed reserve (upgradeBuffer). */
  buffer: number;
  /** max(0, total - buffer) — the discretionary pool. */
  surplus: number;
  /** Target WORK units across upgraders (upgradePower). */
  upgradePower: number;
  /** Target rampart/wall HP (wallHpTarget). */
  wallHpTarget: number;
  /**
   * True when the room has enough surplus above the buffer + reserve margin
   * to safely run a mineral miner.
   * Gate: rcl >= 6 && stage !== 'bootstrap' && total > buffer + MINERAL_RESERVE_MARGIN
   * The MINERAL_RESERVE_MARGIN (15k) is deliberately != any upgrader threshold,
   * so the collision (mining gate == upgrader tier) cannot recur structurally.
   */
  allowMineralMining: boolean;
  /** True when colonyEnergy exceeds zero surplus (export gating in terminal.ts). */
  allowEnergyExport: boolean;
  /**
   * True when total energy exceeds FACTORY_ENERGY_FLOOR (120k).
   * Invariant: UPGRADE_BUFFER[8] = 100k < 120k — factory sits above upgrade band.
   */
  allowFactory: boolean;
}

/**
 * Per-room-per-tick budget snapshot. Cached via tickCache so spawner, towers,
 * factory, and terminal all share one computation.
 *
 * Consumers must resetTickCache() in test beforeEach since the cache is
 * module-level and persists across test cases in the same suite.
 */
export function energyBudget(room: Room): EnergyBudget {
  return cached('economy:budget:' + room.name, () => {
    const stage = economyStage(room);
    const total = colonyEnergy(room);
    const buffer = upgradeBuffer(room);
    const surplus = Math.max(0, total - buffer);
    const rcl = room.controller?.level ?? 0;

    return {
      stage,
      total,
      buffer,
      surplus,
      upgradePower: upgradePower(room),
      wallHpTarget: wallHpTarget(room),
      allowMineralMining:
        rcl >= 6 && stage !== 'bootstrap' && total > buffer + MINERAL_RESERVE_MARGIN,
      allowEnergyExport: surplus > 0,
      allowFactory: total > FACTORY_ENERGY_FLOOR,
    };
  });
}
