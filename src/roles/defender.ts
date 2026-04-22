import { Role } from './Role';
import { pickPriorityTarget } from '../utils/threat';
import { moveTo } from '../utils/movement';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  ATTACK: {
    run(creep) {
      const target = pickPriorityTarget(creep.room);
      if (!target) return 'RALLY';

      if (creep.attack(target) === ERR_NOT_IN_RANGE) {
        moveTo(creep, target, { visualizePathStyle: { stroke: '#ff0000' } });
      }
      return undefined;
    },
  },
  RALLY: {
    run(creep) {
      const target = pickPriorityTarget(creep.room);
      if (target) return 'ATTACK';

      const rally = creep.room.find(FIND_MY_SPAWNS)[0];
      if (rally && !creep.pos.inRangeTo(rally, 3)) {
        moveTo(creep, rally, { range: 3, visualizePathStyle: { stroke: '#888888' } });
      }
      return undefined;
    },
  },
};

export const defender: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'RALLY');
  },
};
