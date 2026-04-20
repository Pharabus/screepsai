/**
 * Shared moveTo wrapper with consistent options.
 *
 * Uses `ignoreCreeps: true` so paths are calculated as if other creeps don't
 * exist. Screeps auto-swaps same-owner creeps that try to move through each
 * other on the same tick, so this eliminates the oscillation loop where
 * multiple creeps bounce around each other recalculating paths.
 *
 * `reusePath: 10` is slightly higher than the default (5) since paths are
 * more stable when creeps aren't dodging each other every tick.
 */

const DEFAULT_MOVE_OPTS: MoveToOpts = {
  ignoreCreeps: true,
  reusePath: 10,
};

export function moveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts,
): CreepMoveReturnCode | ERR_NO_PATH | ERR_INVALID_TARGET | ERR_NOT_FOUND {
  return creep.moveTo(target, { ...DEFAULT_MOVE_OPTS, ...opts });
}
