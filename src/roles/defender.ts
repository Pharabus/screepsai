import { Role } from './Role';
import { pickPriorityTarget } from '../utils/threat';

export const defender: Role = {
  run(creep: Creep): void {
    const target = pickPriorityTarget(creep.room);
    if (target) {
      if (creep.attack(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
      }
      return;
    }

    // No hostiles — rally near the first spawn so we react quickly to the
    // next sighting without burning ticks wandering the room.
    const rally = creep.room.find(FIND_MY_SPAWNS)[0];
    if (rally && !creep.pos.inRangeTo(rally, 3)) {
      creep.moveTo(rally, { visualizePathStyle: { stroke: '#888888' } });
    }
  },
};
