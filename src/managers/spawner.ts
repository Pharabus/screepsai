import { buildBody } from '../utils/body';
import { cached } from '../utils/tickCache';
import { defendersNeeded } from './defense';

interface SpawnRequest {
  role: CreepRoleName;
  pattern: BodyPartConstant[];
  maxRepeats?: number;
  minCount: number;
}

// Priority-ordered: earlier entries spawn first. Defender is injected at the
// top by buildSpawnQueue() only when defense reports a live threat — there's
// no need to keep one standing by in peacetime.
const baseSpawnQueue: SpawnRequest[] = [
  { role: 'harvester', pattern: [WORK, CARRY, MOVE], minCount: 2 },
  { role: 'upgrader', pattern: [WORK, CARRY, MOVE], minCount: 2 },
  { role: 'builder', pattern: [WORK, CARRY, MOVE], minCount: 1 },
  { role: 'repairer', pattern: [WORK, CARRY, MOVE], minCount: 1 },
];

function buildSpawnQueue(): SpawnRequest[] {
  // Sum desired defenders across all owned rooms. defendersNeeded() returns 0
  // unless a threat was seen within the defense memory window.
  let defenders = 0;
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) defenders += defendersNeeded(room);
  }
  if (defenders === 0) return baseSpawnQueue;

  return [
    // ATTACK + MOVE keeps the defender at 1:1 fatigue on plain terrain.
    { role: 'defender', pattern: [ATTACK, MOVE], minCount: defenders },
    ...baseSpawnQueue,
  ];
}

function countCreepsByRole(role: CreepRoleName): number {
  // One tally shared across the whole tick — avoids re-walking Game.creeps
  // once per role in the spawn queue.
  const counts = cached('spawner:countsByRole', () => {
    const totals: Partial<Record<CreepRoleName, number>> = {};
    for (const c of Object.values(Game.creeps)) {
      totals[c.memory.role] = (totals[c.memory.role] ?? 0) + 1;
    }
    return totals;
  });
  return counts[role] ?? 0;
}

export function runSpawner(): void {
  for (const request of buildSpawnQueue()) {
    if (countCreepsByRole(request.role) >= request.minCount) continue;

    const spawn = Object.values(Game.spawns).find((s) => !s.spawning);
    if (!spawn) return;

    const energy = spawn.room.energyCapacityAvailable;
    const body = buildBody(request.pattern, energy, request.maxRepeats);
    if (body.length === 0) return;

    const name = `${request.role}_${Game.time}`;
    const result = spawn.spawnCreep(body, name, {
      memory: { role: request.role },
    });

    if (result === OK) {
      console.log(`Spawning ${request.role} (${body.length} parts): ${name}`);
      return;
    } else if (result === ERR_NOT_ENOUGH_ENERGY) {
      return;
    } else {
      console.log(`Spawn error for ${request.role}: ${result}`);
    }
  }
}
