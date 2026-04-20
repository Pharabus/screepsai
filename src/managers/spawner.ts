import { buildBody } from '../utils/body';
import { cached } from '../utils/tickCache';
import { defendersNeeded } from './defense';
import { ensureRoomPlan } from '../utils/roomPlanner';

interface SpawnRequest {
  role: CreepRoleName;
  pattern: BodyPartConstant[];
  maxRepeats?: number;
  minCount: number;
}

function countCreepsByRole(role: CreepRoleName): number {
  const counts = cached('spawner:countsByRole', () => {
    const totals: Partial<Record<CreepRoleName, number>> = {};
    for (const c of Object.values(Game.creeps)) {
      totals[c.memory.role] = (totals[c.memory.role] ?? 0) + 1;
    }
    return totals;
  });
  return counts[role] ?? 0;
}

/**
 * Count how many sources in a room have containers and still need a miner.
 */
function minersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.sources) return 0;
  let needed = 0;
  for (const entry of mem.sources) {
    if (!entry.containerId) continue; // no container yet, can't mine statically
    if (!entry.minerName || !Game.creeps[entry.minerName]) needed++;
  }
  return needed;
}

/**
 * Hauler count based on source count and room capacity.
 * At low energy capacity haulers are small so we need more of them.
 */
function haulersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.sources) return 0;
  const containerCount = mem.sources.filter((s) => !!s.containerId).length;
  if (containerCount === 0) return 0;
  // Bigger hauler bodies at higher capacity means fewer needed
  const perSource = room.energyCapacityAvailable >= 800 ? 2 : 3;
  return containerCount * perSource;
}

/**
 * Upgrader count. In miner economy, scale to available energy surplus.
 * In bootstrap, keep 2 minimum.
 */
function upgradersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.minerEconomy) return 2;
  const capacity = room.energyCapacityAvailable;
  if (capacity >= 1500) return 3;
  if (capacity >= 800) return 2;
  return 1;
}

/**
 * Builder count scales with active construction sites. At least 1 (they fall
 * back to upgrading when idle), up to 3 when there's heavy construction.
 */
function buildersNeeded(room: Room): number {
  const sites = cached('spawner:sites:' + room.name, () =>
    room.find(FIND_MY_CONSTRUCTION_SITES).length,
  );
  if (sites === 0) return 1; // idle-upgrades
  return Math.min(Math.ceil(sites / 3), 3);
}

/**
 * Repairer count scales with damaged structures. At least 1 (falls back to
 * upgrading), up to 2 when there's significant damage.
 */
function repairersNeeded(room: Room): number {
  const REPAIR_THRESHOLD = 0.75;
  const damaged = cached('spawner:damaged:' + room.name, () =>
    room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.hits < s.hitsMax * REPAIR_THRESHOLD &&
        s.structureType !== STRUCTURE_WALL &&
        s.structureType !== STRUCTURE_RAMPART,
    }).length,
  );
  if (damaged > 5) return 2;
  return 1;
}

function buildSpawnQueue(room: Room): SpawnRequest[] {
  const queue: SpawnRequest[] = [];
  const mem = Memory.rooms[room.name];
  const isMinerEconomy = mem?.minerEconomy ?? false;

  // Priority 0: Defenders (dynamic, only when threat active)
  const defenders = defendersNeeded(room);
  if (defenders > 0) {
    queue.push({ role: 'defender', pattern: [ATTACK, MOVE], minCount: defenders });
  }

  if (isMinerEconomy) {
    // Miner economy: miners first (energy production), then haulers (distribution),
    // then harvesters as emergency bootstrap if both die, then upgraders/builders.
    const miners = minersNeeded(room);
    if (miners > 0) {
      // [WORK, WORK, MOVE] repeated up to 3× = max 6 WORK, 3 MOVE (750 energy).
      // At low capacity (300): 2W 1M (250 energy) — still useful.
      // At 550+: 4W 2M — nearly saturates a source.
      // At 750+: 6W 3M — fully saturates with margin.
      queue.push({ role: 'miner', pattern: [WORK, WORK, MOVE], maxRepeats: 3, minCount: miners + countCreepsByRole('miner') });
    }
    queue.push({ role: 'hauler', pattern: [CARRY, CARRY, MOVE, MOVE], minCount: haulersNeeded(room) });
    // Keep 1 harvester as emergency bootstrap in case all miners die
    queue.push({ role: 'harvester', pattern: [WORK, CARRY, MOVE], minCount: 1 });
    // Upgrader: [WORK, WORK, CARRY, MOVE] × up to 4 = max 8W 4C 4M (1200 energy)
    // At 300: 2W 1C 1M — always affordable. Scales with extensions.
    queue.push({ role: 'upgrader', pattern: [WORK, WORK, CARRY, MOVE], maxRepeats: 4, minCount: upgradersNeeded(room) });
    // Builder: [WORK, CARRY, MOVE, MOVE] × up to 4 = max 4W 4C 8M (800 energy)
    // Needs more MOVE for travel between source and construction sites.
    queue.push({ role: 'builder', pattern: [WORK, CARRY, MOVE, MOVE], maxRepeats: 4, minCount: buildersNeeded(room) });
    queue.push({ role: 'repairer', pattern: [WORK, CARRY, MOVE], minCount: repairersNeeded(room) });
  } else {
    // Bootstrap economy: original patterns
    queue.push({ role: 'harvester', pattern: [WORK, CARRY, MOVE], minCount: 2 });
    queue.push({ role: 'upgrader', pattern: [WORK, CARRY, MOVE], minCount: 2 });
    queue.push({ role: 'builder', pattern: [WORK, CARRY, MOVE], minCount: buildersNeeded(room) });
    queue.push({ role: 'repairer', pattern: [WORK, CARRY, MOVE], minCount: repairersNeeded(room) });
  }

  return queue;
}

export function runSpawner(): void {
  // Ensure room plans are up to date before making spawn decisions
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) ensureRoomPlan(room);
  }

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    const queue = buildSpawnQueue(room);

    for (const request of queue) {
      if (countCreepsByRole(request.role) >= request.minCount) continue;

      const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
      if (!spawn) break;

      const energy = room.energyCapacityAvailable;
      const body = buildBody(request.pattern, energy, request.maxRepeats);
      if (body.length === 0) continue; // can't afford this role, try cheaper ones below

      const name = `${request.role}_${Game.time}`;
      const result = spawn.spawnCreep(body, name, {
        memory: { role: request.role },
      });

      if (result === OK) {
        console.log(`Spawning ${request.role} (${body.length} parts): ${name}`);
        break; // one spawn per room per tick
      } else if (result === ERR_NOT_ENOUGH_ENERGY) {
        break;
      } else {
        console.log(`Spawn error for ${request.role}: ${result}`);
      }
    }
  }
}
