import { pickPriorityTarget } from '../utils/threat';

const REPAIR_THRESHOLD = 0.75;
const WALL_REPAIR_MAX = 10_000; // don't dump all energy into walls
const COMBAT_ENERGY_RESERVE = 0.5; // min fill before using towers for repair

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

    for (const tower of towers) {
      // Priority 2: heal the closest damaged friendly.
      const wounded = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: (c) => c.hits < c.hitsMax,
      });
      if (wounded) {
        tower.heal(wounded);
        continue;
      }

      // Priority 3: repair — only if the tower is above the combat reserve,
      // so we always have energy on hand when hostiles arrive.
      if (
        tower.store.getUsedCapacity(RESOURCE_ENERGY) <
        tower.store.getCapacity(RESOURCE_ENERGY) * COMBAT_ENERGY_RESERVE
      ) {
        continue;
      }

      const damaged = tower.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (s) => {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            return s.hits < WALL_REPAIR_MAX;
          }
          return s.hits < s.hitsMax * REPAIR_THRESHOLD;
        },
      });
      if (damaged) tower.repair(damaged);
    }
  }
}
