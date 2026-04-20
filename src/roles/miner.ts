import { Role } from './Role';
import { assignMiner, findUnminedSource } from '../utils/roomPlanner';
import { moveTo } from '../utils/movement';

/**
 * Static miner. Sits on (or adjacent to) a container next to its assigned
 * source and harvests indefinitely. Never moves once in position.
 *
 * Body pattern: heavy WORK + 1 MOVE (to reach the container once after spawn).
 * 5 WORK parts = 10 energy/tick = fully drains a 3000-energy source per 300-tick regen.
 */
export const miner: Role = {
  run(creep: Creep): void {
    // Assign a source if we don't have one yet
    if (!creep.memory.targetId) {
      const sourceId = findUnminedSource(creep.room.name);
      if (!sourceId) return; // nothing to mine
      creep.memory.targetId = sourceId;
      assignMiner(creep.room.name, sourceId, creep.name);
    }

    const source = Game.getObjectById(creep.memory.targetId as Id<Source>);
    if (!source) {
      creep.memory.targetId = undefined;
      return;
    }

    // Find the container at this source to stand on
    const mem = Memory.rooms[creep.room.name];
    const entry = mem?.sources?.find((s) => s.id === source.id);
    const container = entry?.containerId
      ? Game.getObjectById(entry.containerId)
      : undefined;

    // Move to the container tile (or adjacent to source if no container yet)
    if (container && !creep.pos.isEqualTo(container.pos)) {
      moveTo(creep, container, { visualizePathStyle: { stroke: '#ffaa00' } });
      return;
    }
    if (!container && !creep.pos.isNearTo(source)) {
      moveTo(creep, source, { visualizePathStyle: { stroke: '#ffaa00' } });
      return;
    }

    // Harvest
    creep.harvest(source);
  },
};
