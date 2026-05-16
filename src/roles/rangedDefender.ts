import { Role } from './Role';
import { pickPriorityTarget } from '../utils/threat';
import { moveTo } from '../utils/movement';
import { markIdle } from '../utils/idle';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';

// Ideal engagement range for ranged attackers
const PREFERRED_RANGE = 3;

function kiteStep(creep: Creep, target: Creep): void {
  const range = creep.pos.getRangeTo(target);

  if (range <= 1) {
    // Target is adjacent (or on same tile) — step back before shooting.
    let dx = creep.pos.x - target.pos.x;
    let dy = creep.pos.y - target.pos.y;
    // When dx===0 && dy===0 the retreat vector is a no-op; fall back to moving
    // away from the room centre so the creep doesn't stay glued to the target.
    if (dx === 0 && dy === 0) {
      dx = creep.pos.x >= 25 ? 1 : -1;
      dy = creep.pos.y >= 25 ? 1 : -1;
    }
    // Move to a position one step further away (not into walls)
    const retreatX = Math.max(2, Math.min(47, creep.pos.x + Math.sign(dx)));
    const retreatY = Math.max(2, Math.min(47, creep.pos.y + Math.sign(dy)));
    moveTo(creep, new RoomPosition(retreatX, retreatY, creep.room.name), {
      visualizePathStyle: { stroke: '#ff8800' },
    });
  } else if (range <= PREFERRED_RANGE) {
    // In ideal range — hold position, just shoot
  } else {
    // Too far — close in
    moveTo(creep, target, { range: PREFERRED_RANGE, visualizePathStyle: { stroke: '#ff0000' } });
  }
}

const states: StateMachineDefinition = {
  KITE: {
    run(creep) {
      const target = pickPriorityTarget(creep.room);
      if (!target) return 'RALLY';

      const range = creep.pos.getRangeTo(target);

      // Use mass attack when multiple hostiles cluster within range 3
      const nearby = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: (h) => creep.pos.getRangeTo(h) <= 3,
      });
      if (nearby.length >= 2) {
        creep.rangedMassAttack();
      } else {
        creep.rangedAttack(target);
      }

      kiteStep(creep, target);

      // Stay in KITE while hostiles present
      if (range > 20) return 'RALLY'; // lost sight
      return undefined;
    },
  },
  RALLY: {
    run(creep) {
      const target = pickPriorityTarget(creep.room);
      if (target) return 'KITE';

      markIdle(creep);
      return undefined;
    },
  },
};

export const rangedDefender: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'RALLY');
  },
};
