import { Role } from './Role';
import { moveTo, isInRoomInterior } from '../utils/movement';
import { PRIORITY_DEFAULT } from '../utils/trafficManager';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

const states: StateMachineDefinition = {
  TRAVEL: {
    run(creep) {
      const targetRoom = creep.memory.targetRoom;
      if (!targetRoom) return undefined;
      // Only flip to CLAIM once we're 3+ tiles off any border, so the engine
      // can't auto-evict us back to the previous room next tick.
      if (creep.room.name === targetRoom && isInRoomInterior(creep)) return 'CLAIM';

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
      // Guard against drifting back across a border. Once state flips to CLAIM,
      // any subsequent tick where the creep is in a non-target room would
      // otherwise call claimController on that room's controller. Observed at
      // 80174499: claimer flipped to CLAIM crossing into W44N57, then traffic
      // pushed it back to W44N58 and it claimed the wrong room.
      if (creep.room.name !== creep.memory.targetRoom) {
        return 'TRAVEL';
      }
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
