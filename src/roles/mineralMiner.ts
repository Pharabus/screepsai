import { Role } from './Role';
import { assignMineralMiner } from '../utils/roomPlanner';
import { moveTo } from '../utils/movement';
import { registerStationary, PRIORITY_STATIC, PRIORITY_WORKER } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { MINERAL_TERMINAL_CEILING } from '../utils/thresholds';

const states: StateMachineDefinition = {
  POSITION: {
    run(creep) {
      const mem = Memory.rooms[creep.room.name];
      if (!mem?.mineralId) return undefined;

      if (mem.mineralMinerName !== creep.name) {
        assignMineralMiner(creep.room.name, creep.name);
      }

      const mineral = Game.getObjectById(mem.mineralId);
      if (!mineral || mineral.mineralAmount === 0) return undefined;

      if (mem.mineralContainerId) {
        const container = Game.getObjectById(mem.mineralContainerId);
        if (container) {
          if (creep.pos.isEqualTo(container.pos)) return 'HARVEST';
          moveTo(creep, container, {
            range: 0,
            priority: PRIORITY_WORKER,
            visualizePathStyle: { stroke: '#cc66ff' },
          });
          return undefined;
        }
      }
      if (creep.pos.isNearTo(mineral)) return 'HARVEST';
      moveTo(creep, mineral, {
        priority: PRIORITY_WORKER,
        visualizePathStyle: { stroke: '#cc66ff' },
      });
      return undefined;
    },
  },
  HARVEST: {
    run(creep) {
      registerStationary(creep, PRIORITY_STATIC);

      const mem = Memory.rooms[creep.room.name];
      if (!mem?.mineralId) return 'POSITION';

      if (mem.mineralMinerName !== creep.name) {
        assignMineralMiner(creep.room.name, creep.name);
      }

      const mineral = Game.getObjectById(mem.mineralId);
      if (!mineral || mineral.mineralAmount === 0) return undefined;

      // Throttle: pause when the container is full (prevents overflow decay) or
      // total stockpile has reached the terminal sell ceiling (don't outpace logistics).
      if (mem.mineralContainerId) {
        const container = Game.getObjectById(mem.mineralContainerId);
        if (container && container.store.getFreeCapacity() === 0) return undefined;
      }
      const mineralType = mineral.mineralType;
      const totalStockpile =
        (creep.room.storage?.store.getUsedCapacity(mineralType) ?? 0) +
        (creep.room.terminal?.store.getUsedCapacity(mineralType) ?? 0);
      if (totalStockpile >= MINERAL_TERMINAL_CEILING) return undefined;

      creep.harvest(mineral);
      return undefined;
    },
  },
};

export const mineralMiner: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'POSITION');
  },
};
