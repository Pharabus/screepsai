import { pickPriorityTarget } from '../utils/threat';
import { cached } from '../utils/tickCache';
import { REPAIR_THRESHOLD } from '../utils/thresholds';
const COMBAT_ENERGY_RESERVE = 0.5;

const WALL_CAPS: Record<number, number> = {
  3: 10_000,
  4: 50_000,
  5: 300_000,
  6: 1_000_000,
  7: 5_000_000,
  8: 50_000_000,
};

function wallRepairMax(room: Room): number {
  return cached('towers:wallMax:' + room.name, () => {
    const rcl = room.controller?.level ?? 0;
    const cap = WALL_CAPS[rcl] ?? 10_000;
    const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    return Math.max(10_000, Math.min(Math.floor(stored * 0.5), cap));
  });
}

export function runTowers(): void {
  for (const room of Object.values(Game.rooms)) {
    const towers = room.find(FIND_MY_STRUCTURES, {
      filter: (s): s is StructureTower => s.structureType === STRUCTURE_TOWER,
    });
    if (towers.length === 0) continue;

    // Priority 1: focus-fire the highest-threat hostile. Having every tower
    // fire the same target means healers die before they can negate damage.
    const target = pickPriorityTarget(room);
    if (target) {
      for (const tower of towers) tower.attack(target);
      continue;
    }

    // Cache repair target per room (avoids per-tower find)
    const maxWallHits = wallRepairMax(room);
    const repairTarget = cached(
      'towers:repair:' + room.name,
      () =>
        room.find(FIND_STRUCTURES, {
          filter: (s) => {
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
              return s.hits < maxWallHits;
            }
            return s.hits < s.hitsMax * REPAIR_THRESHOLD;
          },
        })[0],
    );

    for (const tower of towers) {
      const wounded = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: (c) => c.hits < c.hitsMax,
      });
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
