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

    // Backfill homeRoom for creeps spawned before per-room tracking was added.
    // Local creeps have no targetRoom — use their current room as home.
    // Remote creeps without homeRoom are left unset (they'll be ignored in counts
    // until they die and are replaced with homeRoom set on spawn).
    if (!creep.memory.homeRoom && !creep.memory.targetRoom) {
      creep.memory.homeRoom = creep.room.name;
    }

    const role = creep.memory.role ? roles[creep.memory.role] : undefined;
    if (!role) {
      const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn) spawn.recycleCreep(creep);
      continue;
    }
    profile(`role.${creep.memory.role}`, () => role.run(creep));
  }
}

export function runRooms(): void {
  cleanDeadCreepMemory();
  runCreeps();
}
