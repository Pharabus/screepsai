import { buildBody, buildMinerBody, buildRemoteMinerBody, buildUpgraderBody } from '../utils/body';
import { cached } from '../utils/tickCache';
import { defendersNeeded } from './defense';
import { ensureRoomPlan, ensureRemoteRoomPlan, needsMineralMiner } from '../utils/roomPlanner';
import { selectRemoteRooms } from '../utils/remotePlanner';
import { findScoutTarget } from '../roles/scout';
import { STORAGE_ENERGY_FLOOR } from '../utils/sources';

interface SpawnRequest {
  role: CreepRoleName;
  pattern?: BodyPartConstant[];
  body?: BodyPartConstant[];
  maxRepeats?: number;
  minCount: number;
  memory?: CreepMemory;
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

function countRemoteMiners(remoteRoom: string): number {
  return cached('spawner:remoteMiners:' + remoteRoom, () => {
    let count = 0;
    for (const c of Object.values(Game.creeps)) {
      if (c.memory.role === 'miner' && c.memory.targetRoom === remoteRoom) count++;
    }
    return count;
  });
}

function countRemoteHaulers(remoteRoom: string): number {
  return cached('spawner:remoteHaulers:' + remoteRoom, () => {
    let count = 0;
    for (const c of Object.values(Game.creeps)) {
      if (c.memory.role === 'remoteHauler' && c.memory.targetRoom === remoteRoom) count++;
    }
    return count;
  });
}

function countReservers(remoteRoom: string): number {
  return cached('spawner:reservers:' + remoteRoom, () => {
    let count = 0;
    for (const c of Object.values(Game.creeps)) {
      if (c.memory.role === 'reserver' && c.memory.targetRoom === remoteRoom) count++;
    }
    return count;
  });
}

export function remoteBuilderNeeded(remoteRoom: string): boolean {
  const room = Game.rooms[remoteRoom];
  if (!room) return false;
  for (const c of Object.values(Game.creeps)) {
    if (c.memory.role === 'remoteBuilder' && c.memory.targetRoom === remoteRoom) return false;
  }
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  if (sites.length > 0) return true;
  const damagedRoads = room.find(FIND_STRUCTURES, {
    filter: (s) => s.structureType === STRUCTURE_ROAD && s.hits < s.hitsMax * 0.5,
  });
  return damagedRoads.length > 0;
}

/**
 * Count how many sources in a room have containers and still need a miner.
 */
export function minersNeeded(room: Room): number {
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
export function haulersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.sources) return 0;
  const withContainers = mem.sources.filter((s) => !!s.containerId);
  if (withContainers.length === 0) return 0;

  const perUnlinked = room.energyCapacityAvailable >= 800 ? 2 : 3;
  const linked = withContainers.filter(
    (s) => s.linkId && Game.getObjectById(s.linkId as Id<StructureLink>),
  ).length;
  const unlinked = withContainers.length - linked;

  // Linked sources need fewer haulers but still require distribution to
  // spawns/extensions/towers; unlinked sources need full hauler complement
  let count = Math.max(unlinked * perUnlinked + Math.min(linked, 1), 2);

  // +1 when mineral mining is active so the mineral container doesn't overflow
  if (mem.mineralId && mem.mineralContainerId) {
    const mineral = Game.getObjectById(mem.mineralId as Id<Mineral>);
    if (mineral && mineral.mineralAmount > 0) count += 1;
  }

  return count;
}

/**
 * Upgrader count. In miner economy, scale to storage energy reserves.
 * Deliberately conservative below 100k to let the economy build surplus
 * before adding upgrade drain. In bootstrap, keep 2 minimum.
 */
export function upgradersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.minerEconomy) return 2;

  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;

  if (stored < 100_000) return 1;
  if (stored < 200_000) return 2;
  if (stored < 500_000) return 3;
  return 4;
}

/**
 * Builder count scales with active construction sites. At least 1 (they fall
 * back to upgrading when idle), up to 3 when there's heavy construction.
 */
function buildersNeeded(room: Room): number {
  const storage = room.storage;
  const mem = Memory.rooms[room.name];
  const sources = mem?.sources;
  const allSourcesLinked =
    sources !== undefined && sources.length > 0 && sources.every((s) => s.linkId);
  if (
    storage &&
    allSourcesLinked &&
    storage.store.getUsedCapacity(RESOURCE_ENERGY) < STORAGE_ENERGY_FLOOR
  )
    return 0;

  const sites = cached(
    'spawner:sites:' + room.name,
    () => room.find(FIND_MY_CONSTRUCTION_SITES).length,
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
  const damaged = cached(
    'spawner:damaged:' + room.name,
    () =>
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

function mineralMinersNeeded(room: Room): number {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return 0;
  // Check if extractor is built
  const hasExtractor =
    room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTRACTOR,
    }).length > 0;
  if (!hasExtractor) return 0;
  // Don't mine minerals until energy reserves are healthy and labs are running
  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const mem = Memory.rooms[room.name];
  if (stored < 100_000 || !mem?.activeReaction) return 0;
  return needsMineralMiner(room.name) ? 1 : 0;
}

export function buildSpawnQueue(room: Room): SpawnRequest[] {
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
      queue.push({
        role: 'miner',
        body: buildMinerBody(room.energyCapacityAvailable),
        minCount: miners + countCreepsByRole('miner'),
      });
    }
    queue.push({
      role: 'hauler',
      pattern: [CARRY, CARRY, MOVE, MOVE],
      maxRepeats: 8,
      minCount: haulersNeeded(room),
    });
    // Keep 1 harvester as emergency bootstrap in case all miners die
    queue.push({ role: 'harvester', pattern: [WORK, CARRY, MOVE], maxRepeats: 4, minCount: 1 });
    // Cap upgrader body at 5 WORK while storage is very low to limit per-tick drain
    const storedEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    const upgraderEnergyCap = storedEnergy < 50_000 ? 600 : room.energyCapacityAvailable;
    queue.push({
      role: 'upgrader',
      body: buildUpgraderBody(upgraderEnergyCap),
      minCount: upgradersNeeded(room),
    });
    // Builder: [WORK, CARRY, MOVE, MOVE] × up to 4 = max 4W 4C 8M (800 energy)
    // Needs more MOVE for travel between source and construction sites.
    queue.push({
      role: 'builder',
      pattern: [WORK, CARRY, MOVE, MOVE],
      maxRepeats: 4,
      minCount: buildersNeeded(room),
    });
    queue.push({
      role: 'repairer',
      pattern: [WORK, CARRY, MOVE],
      maxRepeats: 4,
      minCount: repairersNeeded(room),
    });
    const mineralMiners = mineralMinersNeeded(room);
    if (mineralMiners > 0) {
      queue.push({
        role: 'mineralMiner',
        pattern: [WORK, WORK, MOVE],
        maxRepeats: 5,
        minCount: mineralMiners,
      });
    }
    // Remote mining roles (lower priority than local economy)
    const remoteRooms = mem?.remoteRooms ?? [];
    for (const remoteRoom of remoteRooms) {
      const remoteMem = Memory.rooms[remoteRoom];
      const remoteBody = buildRemoteMinerBody(room.energyCapacityAvailable);
      if (remoteBody.length === 0) continue;
      const sourceCount = remoteMem?.sources?.length ?? remoteMem?.scoutedSources ?? 0;
      if (sourceCount === 0) continue;

      const existingRemoteMiners = countRemoteMiners(remoteRoom);
      const existingRemoteHaulers = countRemoteHaulers(remoteRoom);
      const totalMiners = countCreepsByRole('miner');
      const totalHaulers = countCreepsByRole('remoteHauler');

      // Spawn remote miners: 1 per source, using source assignments when available
      if (remoteMem?.sources) {
        for (const entry of remoteMem.sources) {
          if (entry.minerName && Game.creeps[entry.minerName]) continue;
          queue.push({
            role: 'miner',
            body: remoteBody,
            minCount: totalMiners + 1,
            memory: { role: 'miner' as CreepRoleName, homeRoom: room.name, targetRoom: remoteRoom },
          });
        }
      } else if (existingRemoteMiners < sourceCount) {
        queue.push({
          role: 'miner',
          body: remoteBody,
          minCount: totalMiners + 1,
          memory: { role: 'miner' as CreepRoleName, homeRoom: room.name, targetRoom: remoteRoom },
        });
      }

      // Remote haulers: 2 per source
      const haulersWanted = sourceCount * 2;
      if (existingRemoteHaulers < haulersWanted) {
        queue.push({
          role: 'remoteHauler',
          pattern: [CARRY, CARRY, MOVE, MOVE],
          maxRepeats: 8,
          minCount: totalHaulers + 1,
          memory: {
            role: 'remoteHauler' as CreepRoleName,
            homeRoom: room.name,
            targetRoom: remoteRoom,
          },
        });
      }

      // Reserver: 1 per remote room with a controller
      const hasController = remoteMem?.scoutedHasController ?? !!remoteMem?.scoutedOwner;
      if (hasController && countReservers(remoteRoom) === 0) {
        queue.push({
          role: 'reserver',
          body: [CLAIM, CLAIM, MOVE, MOVE],
          minCount: countCreepsByRole('reserver') + 1,
          memory: {
            role: 'reserver' as CreepRoleName,
            homeRoom: room.name,
            targetRoom: remoteRoom,
          },
        });
      }

      // Remote builder: 1 per remote room with construction sites
      if (remoteBuilderNeeded(remoteRoom)) {
        queue.push({
          role: 'remoteBuilder',
          pattern: [WORK, CARRY, MOVE, MOVE],
          maxRepeats: 4,
          minCount: countCreepsByRole('remoteBuilder') + 1,
          memory: {
            role: 'remoteBuilder' as CreepRoleName,
            homeRoom: room.name,
            targetRoom: remoteRoom,
          },
        });
      }
    }
    // Scout: only spawn when there's a room to explore
    if (findScoutTarget(room.name)) {
      queue.push({
        role: 'scout',
        pattern: [MOVE],
        maxRepeats: 1,
        minCount: 1,
        memory: { role: 'scout' as CreepRoleName, homeRoom: room.name },
      });
    }
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
    if (room.controller?.my) {
      ensureRoomPlan(room);
      // Periodically re-evaluate remote room selection
      if (Game.time % 100 === 0) selectRemoteRooms(room);
      // Scan remote rooms we have visibility into
      const remoteRooms = Memory.rooms[room.name]?.remoteRooms ?? [];
      for (const remoteName of remoteRooms) {
        ensureRemoteRoomPlan(remoteName);
      }
    }
  }

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    const queue = buildSpawnQueue(room);

    // Emergency recovery: if in miner economy but no haulers or harvesters alive,
    // extensions can't be filled so energyAvailable stays at spawn-only levels.
    // Build bodies from energyAvailable instead of capacity to break the deadlock.
    const mem = Memory.rooms[room.name];
    const hasDistributor = countCreepsByRole('hauler') > 0 || countCreepsByRole('harvester') > 0;
    const emergency = (mem?.minerEconomy ?? false) && !hasDistributor;

    for (const request of queue) {
      if (countCreepsByRole(request.role) >= request.minCount) continue;

      const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
      if (!spawn) break;

      const energy = emergency ? room.energyAvailable : room.energyCapacityAvailable;
      const body = request.body ?? buildBody(request.pattern!, energy, request.maxRepeats);
      if (body.length === 0) continue; // can't afford this role, try cheaper ones below

      const name = `${request.role}_${Game.time}`;
      const result = spawn.spawnCreep(body, name, {
        memory: request.memory ?? { role: request.role },
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
