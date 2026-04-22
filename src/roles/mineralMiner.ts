import { Role } from './Role';
import { assignMineralMiner } from '../utils/roomPlanner';
import { moveTo } from '../utils/movement';

export const mineralMiner: Role = {
  run(creep: Creep): void {
    const mem = Memory.rooms[creep.room.name];
    if (!mem?.mineralId) return;

    // Register assignment
    if (mem.mineralMinerName !== creep.name) {
      assignMineralMiner(creep.room.name, creep.name);
    }

    const mineral = Game.getObjectById(mem.mineralId);
    if (!mineral || mineral.mineralAmount === 0) return;

    // Move to mineral container (or adjacent to mineral)
    if (mem.mineralContainerId) {
      const container = Game.getObjectById(mem.mineralContainerId);
      if (container && !creep.pos.isEqualTo(container.pos)) {
        moveTo(creep, container, { visualizePathStyle: { stroke: '#cc66ff' } });
        return;
      }
    } else if (!creep.pos.isNearTo(mineral)) {
      moveTo(creep, mineral, { visualizePathStyle: { stroke: '#cc66ff' } });
      return;
    }

    creep.harvest(mineral);
  },
};
