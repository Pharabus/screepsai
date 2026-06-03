import { pickPriorityTarget } from '../utils/threat';
import { cached, getStructuresByType } from '../utils/tickCache';
import { REPAIR_THRESHOLD } from '../utils/thresholds';
import { isOperational } from '../utils/structures';
import { logCombat } from '../utils/combatLog';

const COMBAT_ENERGY_RESERVE = 0.5;

// Hard upper limit on rampart/wall HP per RCL — prevents wasting repair energy
// on walls that cost more to maintain than they're worth at that tier.
const WALL_CAPS: Record<number, number> = {
  3: 10_000,
  4: 50_000,
  5: 300_000,
  6: 1_000_000,
  7: 5_000_000,
  8: 50_000_000,
};

// Minimum rampart/wall HP we always try to maintain, regardless of storage
// level. Prevents the purely storage-scaled formula from leaving paper-thin
// ramparts during temporarily lean periods. Values are set so the energy cost
// of reaching and holding the floor is modest relative to normal income.
// The storage-scaled value (stored × 0.5) takes over once storage grows large
// enough to exceed the floor naturally.
const WALL_FLOOR: Record<number, number> = {
  3: 10_000,
  4: 50_000,
  5: 150_000,
  6: 300_000,
  7: 1_000_000,
  8: 5_000_000,
};

function wallRepairMax(room: Room): number {
  return cached('towers:wallMax:' + room.name, () => {
    const rcl = room.controller?.level ?? 0;
    const cap = WALL_CAPS[rcl] ?? 10_000;
    const floor = WALL_FLOOR[rcl] ?? 10_000;
    const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    // Use whichever is higher: the RCL minimum floor or the storage-scaled
    // value — then clamp to the RCL cap so we don't over-invest.
    return Math.min(Math.max(floor, Math.floor(stored * 0.5)), cap);
  });
}

// Tower energy % below which we log a tower_energy_low event during combat.
const TOWER_DRAIN_WARN_PCT = 25;

export function runTowers(): void {
  for (const room of Object.values(Game.rooms)) {
    const towers = (
      (getStructuresByType(room)[STRUCTURE_TOWER] as StructureTower[] | undefined) ?? []
    ).filter(isOperational);
    if (towers.length === 0) continue;

    // Priority 1: focus-fire the highest-threat hostile. Having every tower
    // fire the same target means healers die before they can negate damage.
    const target = pickPriorityTarget(room);
    if (target) {
      for (const tower of towers) tower.attack(target);

      // Log once per combat if any tower's energy is critically low — a tower
      // running dry mid-fight can't attack, which is a silent defence failure.
      const mem = Memory.rooms[room.name];
      if (mem && !mem.combatTowerDrainLogged) {
        const minEnergyPct = Math.min(
          ...towers.map((t) =>
            Math.floor(
              (t.store.getUsedCapacity(RESOURCE_ENERGY) / t.store.getCapacity(RESOURCE_ENERGY)) *
                100,
            ),
          ),
        );
        if (minEnergyPct < TOWER_DRAIN_WARN_PCT) {
          mem.combatTowerDrainLogged = true;
          logCombat({
            tick: Game.time,
            room: room.name,
            event: 'tower_energy_low',
            towerCount: towers.length,
            minTowerEnergy: minEnergyPct,
          });
        }
      }
      continue;
    }

    // Cache repair target per room (avoids per-tower find)
    const maxWallHits = wallRepairMax(room);
    const repairTarget = cached('towers:repair:' + room.name, () => {
      // Pre-compute the set of tiles that currently have a constructed wall.
      // Ramparts sitting on wall tiles are transitional artefacts from the RCL-5
      // build phase — the wall is the intended long-term barrier there, not the
      // rampart. We let them decay naturally by simply not repairing them.
      const wallTileKeys = new Set(
        ((getStructuresByType(room)[STRUCTURE_WALL] as StructureWall[] | undefined) ?? []).map(
          (w) => `${w.pos.x},${w.pos.y}`,
        ),
      );

      const allStructs = Object.values(getStructuresByType(room)).flatMap((s) => s ?? []);
      return allStructs.find((s) => {
        if (s.structureType === STRUCTURE_RAMPART) {
          // Don't repair ramparts co-located with a wall.
          if (wallTileKeys.has(`${s.pos.x},${s.pos.y}`)) return false;
          return s.hits < maxWallHits;
        }
        if (s.structureType === STRUCTURE_WALL) {
          return s.hits < maxWallHits;
        }
        return s.hits < s.hitsMax * REPAIR_THRESHOLD;
      });
    });

    const woundedCreeps = cached('towers:wounded:' + room.name, () =>
      room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax }),
    );

    for (const tower of towers) {
      const wounded =
        woundedCreeps.length > 0
          ? woundedCreeps.reduce<Creep | null>((best, c) => {
              if (!best) return c;
              return tower.pos.getRangeTo(c) < tower.pos.getRangeTo(best) ? c : best;
            }, null)
          : null;
      if (wounded) {
        tower.heal(wounded);
        continue;
      }

      if (
        tower.store.getUsedCapacity(RESOURCE_ENERGY) <
        tower.store.getCapacity(RESOURCE_ENERGY) * COMBAT_ENERGY_RESERVE
      ) {
        continue;
      }

      if (repairTarget) tower.repair(repairTarget);
    }
  }
}
