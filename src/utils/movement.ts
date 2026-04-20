/**
 * Shared moveTo wrapper with consistent options.
 *
 * Uses a hybrid approach:
 * - Far from target (>3 tiles): ignoreCreeps = true. Paths calculate as if
 *   other creeps don't exist, eliminating the oscillation loop where creeps
 *   endlessly recalculate around each other.
 * - Close to target (<=3 tiles): ignoreCreeps = false. Creeps respect each
 *   other and spread around the target from different angles instead of all
 *   queueing behind the same optimal tile.
 *
 * Screeps auto-swaps same-owner creeps that try to move through each other
 * on the same tick, so the close-range pathfinding still resolves quickly.
 */

const FAR_THRESHOLD = 3;

export function moveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveToOpts,
): CreepMoveReturnCode | ERR_NO_PATH | ERR_INVALID_TARGET | ERR_NOT_FOUND {
  const targetPos = 'pos' in target ? target.pos : target;
  const distance = creep.pos.getRangeTo(targetPos);

  const defaults: MoveToOpts = {
    ignoreCreeps: distance > FAR_THRESHOLD,
    reusePath: distance > FAR_THRESHOLD ? 10 : 3,
  };

  return creep.moveTo(target, { ...defaults, ...opts });
}
