import { Role } from './Role';
import { assignMiner, findUnminedSource } from '../utils/roomPlanner';
import { moveTo } from '../utils/movement';
import { registerStationary, PRIORITY_STATIC, PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  POSITION: {
    run(creep) {
      if (!creep.memory.targetId) {
        const sourceId = findUnminedSource(creep.room.name);
        if (!sourceId) return undefined;
        creep.memory.targetId = sourceId;
        assignMiner(creep.room.name, sourceId, creep.name);
      }

      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);
      if (!source) {
        creep.memory.targetId = undefined;
        return undefined;
      }

      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === source.id);
      const container = entry?.containerId
        ? Game.getObjectById(entry.containerId)
        : undefined;

      if (container) {
        if (creep.pos.isEqualTo(container.pos)) return 'HARVEST';
        moveTo(creep, container, { priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#ffaa00' } });
      } else {
        if (creep.pos.isNearTo(source)) return 'HARVEST';
        moveTo(creep, source, { priority: PRIORITY_WORKER, visualizePathStyle: { stroke: '#ffaa00' } });
      }
      return undefined;
    },
  },
  HARVEST: {
    run(creep) {
      registerStationary(creep, PRIORITY_STATIC);

      const source = Game.getObjectById(creep.memory.targetId as Id<Source>);
      if (!source) {
        creep.memory.targetId = undefined;
        return 'POSITION';
      }

      creep.harvest(source);

      const mem = Memory.rooms[creep.room.name];
      const entry = mem?.sources?.find((s) => s.id === source.id);
      if (entry?.linkId && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        const link = Game.getObjectById(entry.linkId);
        if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          creep.transfer(link, RESOURCE_ENERGY);
        }
      }
      return undefined;
    },
  },
};

export const miner: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'POSITION');
  },
};
