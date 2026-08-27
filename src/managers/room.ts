import { roles } from '../roles';
import { profile } from '../utils/profiler';
import { shouldThrottleCreep } from '../utils/creepThrottle';

function cleanDeadCreepMemory(): void {
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }
}

function runCreeps(): void {
  let throttledThisTick = 0;
  let totalCreeps = 0;

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (!creep) continue;
    totalCreeps++;

    // A creep still being spawned exists in Game.creeps but every action
    // (including move()) returns ERR_BUSY until spawning completes — the
    // engine spends CREEP_SPAWN_TIME (3 ticks) per body part, so a 17-part
    // upgrader is immobile for its first 51 ticks and a 32-part hauler for
    // 96. Without this guard, role.run() dispatched every tick anyway: the
    // state machine ran, ensureBoosted() started its 60-tick wait-timeout
    // clock, and moveTo() drove the full stuck-detection escalation
    // (repeated force-repaths at avoidCost up to 200) against a creep that
    // could not move for any reason a repath could fix — all of it pure
    // waste, and for a boost-seeking creep it could burn most or all of the
    // 60-tick budget before the creep was even capable of taking a step.
    // Live-observed (2026-08-27): W42N59 upgraders timing out on boosts despite
    // a 4-tile path and ample supply, and W44N57 creeps racking up 15-38 stuck
    // "cycles" (45-100+ ticks of pointless repathing) simultaneously — both
    // symptoms of this same root cause, not a traffic or lab-access problem.
    if (creep.spawning) continue;

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

    if (shouldThrottleCreep(creep)) {
      throttledThisTick++;
      continue;
    }

    profile(`role.${creep.memory.role}`, () => role.run(creep));
  }

  if (Memory.creepThrottle && Game.time % 100 === 0) {
    console.log(
      `[throttle] skipped ${throttledThisTick}/${totalCreeps} creeps, bucket=${Game.cpu.bucket}`,
    );
  }
}

export function runRooms(): void {
  cleanDeadCreepMemory();
  runCreeps();
}
