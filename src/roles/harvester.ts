import { Role } from './Role';
import { harvestFromBestSource, withdrawFromLogistics } from '../utils/sources';
import { markIdle } from '../utils/idle';
import { runStateMachine, StateMachineDefinition } from '../utils/stateMachine';
import { deliverToSpawnOrExtension, deliverToTower } from '../utils/delivery';

const states: StateMachineDefinition = {
  HARVEST: {
    run(creep) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return 'DELIVER';

      const mem = Memory.rooms[creep.room.name];
      if (mem?.minerEconomy) {
        if (!withdrawFromLogistics(creep)) {
          harvestFromBestSource(creep);
        }
      } else {
        harvestFromBestSource(creep);
      }
      return undefined;
    },
    onEnter(creep) {
      delete creep.memory.targetId;
    },
  },
  DELIVER: {
    // Delegates to the shared, cached-target delivery helpers (delivery.ts)
    // instead of re-picking a target from scratch with a bare `.find()` every
    // tick. The old approach had no commitment: with many creeps concurrently
    // filling extensions, `getFreeCapacity() > 0` on the first array entry can
    // flip tick-to-tick, so the "first match" itself could flip between two
    // structures on opposite sides of the room -- each flip re-running
    // PathFinder toward a brand-new destination and (worst case) exactly
    // cancelling the previous tick's step. Live-observed (2026-09-07):
    // a W44N57 harvester carrying 50 energy sat frozen at the same tile for
    // 84+ ticks with a fully open, single-step path to the nearest spawn --
    // no traffic blocker, zero fatigue, just never actually progressing
    // toward a stable destination. deliverToSpawnOrExtension/deliverToTower
    // cache `creep.memory.targetId` and only drop it once genuinely invalid,
    // eliminating the flip.
    run(creep) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return 'HARVEST';
      if (deliverToSpawnOrExtension(creep)) return undefined;
      if (deliverToTower(creep)) return undefined;
      markIdle(creep);
      return undefined;
    },
  },
};

export const harvester: Role = {
  run(creep: Creep): void {
    runStateMachine(creep, states, 'HARVEST');
  },
};
