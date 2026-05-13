import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { handleRemoteThreat } from '../utils/remoteThreat';

const states: StateMachineDefinition = {
  RESERVE: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;

      if (creep.room.name !== targetRoom) {
        const targetPos = new RoomPosition(25, 25, targetRoom);
        moveTo(creep, targetPos, {
          range: 20,
          priority: PRIORITY_DEFAULT,
          visualizePathStyle: { stroke: '#ffff00' },
        });
        return undefined;
      }

      const controller = creep.room.controller;
      if (!controller) return undefined;

      const result = creep.reserveController(controller);
      if (result === ERR_NOT_IN_RANGE) {
        moveTo(creep, controller, {
          range: 1,
          priority: PRIORITY_DEFAULT,
          visualizePathStyle: { stroke: '#ffff00' },
        });
      }
      return undefined;
    },
  },
};

export const reserver: Role = {
  run(creep: Creep): void {
    if (handleRemoteThreat(creep)) return;
    runStateMachine(creep, states, 'RESERVE');
  },
};
