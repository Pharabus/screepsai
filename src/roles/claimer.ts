import { Role } from './Role';
import { moveTo } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;
      if (creep.room.name === targetRoom) return 'CLAIM';

      moveTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        priority: PRIORITY_DEFAULT,
        visualizePathStyle: { stroke: '#00ffff' },
      });
      return undefined;
    },
  },
  CLAIM: {
    run(creep) {
      const controller = creep.room.controller;
      if (!controller) return undefined;

      // Already ours — recycle. The colony pipeline will pick up via Memory.colonies.
      if (controller.my) {
        const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
        if (spawn) spawn.recycleCreep(creep);
        return undefined;
      }

      const result = creep.claimController(controller);
      if (result === ERR_NOT_IN_RANGE) {
        moveTo(creep, controller, {
          range: 1,
          priority: PRIORITY_DEFAULT,
          visualizePathStyle: { stroke: '#00ffff' },
        });
      } else if (result === ERR_GCL_NOT_ENOUGH) {
        // Should be caught by startClaim, but log and stop attempting if we get here.
        console.log(`[claimer] ${creep.name}: GCL too low — recycling`);
        creep.suicide();
      }
      return undefined;
    },
  },
};

export const claimer: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'TRAVEL');
  },
};
