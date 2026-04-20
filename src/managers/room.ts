import { roles } from '../roles';
import { profile } from '../utils/profiler';

function cleanDeadCreepMemory(): void {
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }
}

function runCreeps(): void {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (!creep) continue;

    const role = roles[creep.memory.role];
    profile(`role.${creep.memory.role}`, () => role.run(creep));
  }
}

export function runRooms(): void {
  cleanDeadCreepMemory();
  runCreeps();
}
