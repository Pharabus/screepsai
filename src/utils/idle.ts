import { moveTo } from './movement';
import { PRIORITY_DEFAULT } from './trafficManager';

const idleCreeps = new Set<string>();

export function markIdle(creep: Creep): void {
  idleCreeps.add(creep.name);
  const target = creep.room.storage ?? creep.room.find(FIND_MY_SPAWNS)[0];
  if (target && !creep.pos.inRangeTo(target, 3)) {
    moveTo(creep, target, {
      range: 3,
      priority: PRIORITY_DEFAULT,
      visualizePathStyle: { stroke: '#888888' },
    });
  }
}

export function drawIdleIndicators(): void {
  for (const name of idleCreeps) {
    const creep = Game.creeps[name];
    if (!creep) continue;
    new RoomVisual(creep.room.name).circle(creep.pos, {
      radius: 0.4,
      fill: 'transparent',
      stroke: '#888888',
      strokeWidth: 0.1,
      opacity: 0.6,
    });
  }
}

export function resetIdle(): void {
  idleCreeps.clear();
}
