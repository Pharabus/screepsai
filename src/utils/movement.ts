import { registerMove, PRIORITY_DEFAULT } from './trafficManager';

export interface MoveOpts {
  range?: number;
  priority?: number;
  visualizePathStyle?: { stroke: string };
}

export function moveTo(
  creep: Creep,
  target: RoomPosition | { pos: RoomPosition },
  opts?: MoveOpts,
): void {
  const targetPos = 'pos' in target ? target.pos : target;
  const range = opts?.range ?? 1;
  const priority = opts?.priority ?? PRIORITY_DEFAULT;

  registerMove(creep, targetPos, priority, range, opts?.visualizePathStyle?.stroke);
}
