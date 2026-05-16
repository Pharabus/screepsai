import {
  buildBody,
  buildHunterBody,
  buildMinerBody,
  buildRemoteMinerBody,
  buildUpgraderBody,
} from '../utils/body';
import { cached } from '../utils/tickCache';
import { defendersNeeded } from './defense';
import { threatScore } from '../utils/threat';
import { ensureRoomPlan, ensureRemoteRoomPlan, needsMineralMiner } from '../utils/roomPlanner';
import { selectRemoteRooms } from '../utils/remotePlanner';
import { findScoutTarget } from '../roles/scout';
import { STORAGE_ENERGY_FLOOR } from '../utils/sources';
import { REPAIR_THRESHOLD } from '../utils/thresholds';
import { coloniesForHome, updateColonyStates } from '../utils/colonyPlanner';

type SpawnRequest = {
  role: CreepRoleName;
  minCount: number;
  memory?: CreepMemory;
} & (
  | { pattern: BodyPartConstant[]; body?: never; maxRepeats?: number }
  | { body: BodyPartConstant[]; pattern?: never; maxRepeats?: never }
);

function resolveHomeRoom(c: Creep): string {
  if (c.memory.homeRoom) return c.memory.homeRoom;
  // Remote creeps without homeRoom set cannot be reliably assigned — skip
  if (c.memory.targetRoom) return '';
  // Local creep: fall back to current room (safe access for tests without room set)
  return c.room?.name ?? '';
}

function countCreepsByRole(role: CreepRoleName, homeRoom: string): number {
  const counts = cached('spawner:countsByHome:' + homeRoom, () => {
    const totals: Partial<Record<CreepRoleName, number>> = {};
    for (const c of Object.values(Game.creeps)) {
      const home = resolveHomeRoom(c);
      if (home !== homeRoom) continue;
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

function countCreepsByRoleAndTarget(role: CreepRoleName, targetRoom: string): number {
  return cached(`spawner:${role}:target:${targetRoom}`, () => {
    let count = 0;
    for (const c of Object.values(Game.creeps)) {
      if (c.memory.role === role && c.memory.targetRoom === targetRoom) count++;
    }
    return count;
  });
}

/**
 * Body for the one-shot claimer creep. [CLAIM, MOVE×5] = 850 energy, 1:1 MOVE
 * ratio for plain-terrain off-road travel. Claimer TTL is 600 ticks so it must
 * reach its target within that window.
 */
function buildClaimerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < 850) return [];
  return [CLAIM, MOVE, MOVE, MOVE, MOVE, MOVE];
}

/**
 * How many colony builders this colony wants. 2 at RCL 0 (pre-spawn) so the
 * first spawn site lands quickly even if one dies in transit; reduces to 1
 * once a spawn exists (colony bootstraps its own builders from there).
 */
function colonyBuildersWanted(targetRoom: string): number {
  const room = Game.rooms[targetRoom];
  if (!room) return 2; // no visibility yet — keep the pipeline pre-warmed
  const hasSpawn = room.find(FIND_MY_SPAWNS).length > 0;
  return hasSpawn ? 1 : 2;
}

export function remoteBuilderNeeded(remoteRoom: string): boolean {
  const room = Game.rooms[remoteRoom];
  if (!room) return false;
  for (const c of Object.values(Game.creeps)) {
    if (c.memory.role === 'remoteBuilder' && c.memory.targetRoom === remoteRoom) return false;
  }
  const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
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

  if (room.storage && stored < 5_000) return 0; // pause — let remotes refill before resuming drain
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
  if (sites === 0) return 0;
  return Math.min(Math.ceil(sites / 3), 3);
}

/**
 * Repairer count scales with damaged structures. At least 1 (falls back to
 * upgrading), up to 2 when there's significant damage.
 */
export function repairersNeeded(room: Room): number {
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
  if (damaged === 0) return 0;
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

export interface DefenderComposition {
  melee: number;
  ranged: number;
  healer: number;
}

export function defenderComposition(room: Room): DefenderComposition {
  const needed = defendersNeeded(room);
  if (needed === 0) return { melee: 0, ranged: 0, healer: 0 };

  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  const totalThreat = hostiles.reduce((sum, h) => sum + threatScore(h), 0);
  const hasHealer = hostiles.some((h) => h.body.some((p) => p.type === HEAL && p.hits > 0));

  let melee: number, ranged: number, healer: number;

  if (totalThreat <= 200) {
    melee = 1;
    ranged = 0;
    healer = 0;
  } else if (totalThreat <= 600) {
    melee = 1;
    ranged = 1;
    healer = 0;
  } else {
    melee = 1;
    ranged = 2;
    healer = 1;
  }

  // Bump ranged count when enemy has healers — kiting is more effective than melee
  if (hasHealer && ranged < 2) ranged++;

  // Cap total at MAX_DEFENDERS_PER_ROOM (4)
  const total = melee + ranged + healer;
  if (total > 4) {
    healer = Math.max(0, 4 - melee - ranged);
  }

  return { melee, ranged, healer };
}

/** Ticks after last Invader sighting before the target room is considered clear. */
const INVADER_MEMORY_TICKS = 500;

function hasActiveInvader(roomName: string): boolean {
  const mem = Memory.rooms[roomName];
  if (!mem?.invaderSeenAt) return false;
  return Game.time - mem.invaderSeenAt < INVADER_MEMORY_TICKS;
}

/**
 * Rooms containing active NPC Invaders that this colony should dispatch a
 * hunter to: includes every remoteRoom and every transit room on the path to
 * a colony that hasn't gone active yet.
 */
function getInvaderTargetRooms(homeRoom: Room): string[] {
  const mem = Memory.rooms[homeRoom.name];
  const targets: string[] = [];

  for (const remote of mem?.remoteRooms ?? []) {
    if (hasActiveInvader(remote) && !targets.includes(remote)) targets.push(remote);
  }

  if (Memory.colonies) {
    for (const [, state] of Object.entries(Memory.colonies)) {
      if (state.homeRoom !== homeRoom.name) continue;
      // Always watch transit rooms regardless of colony status — inter-colony
      // traffic continues to traverse them after the colony goes active.
      for (const transit of state.transitRooms ?? []) {
        if (hasActiveInvader(transit) && !targets.includes(transit)) targets.push(transit);
      }
    }
  }

  return targets;
}

/** Count of unique invader-infested rooms that still need a hunter. */
export function huntersNeeded(homeRoom: Room): number {
  return getInvaderTargetRooms(homeRoom).length;
}

export function buildSpawnQueue(room: Room): SpawnRequest[] {
  const queue: SpawnRequest[] = [];
  const mem = Memory.rooms[room.name];
  const isMinerEconomy = mem?.minerEconomy ?? false;

  // Priority 0: Defenders (dynamic, only when threat active)
  const comp = defenderComposition(room);
  if (comp.melee > 0) {
    queue.push({ role: 'defender', pattern: [ATTACK, MOVE], minCount: comp.melee });
  }
  if (comp.ranged > 0) {
    queue.push({
      role: 'rangedDefender',
      pattern: [RANGED_ATTACK, MOVE],
      maxRepeats: 5,
      minCount: comp.ranged,
    });
  }
  if (comp.healer > 0) {
    queue.push({
      role: 'healer',
      pattern: [HEAL, MOVE],
      maxRepeats: 4,
      minCount: comp.healer,
    });
  }

  // Priority 1: Hunters for NPC invaders in remote/transit rooms — queued before
  // local economy roles so an invader camping a remote doesn't block indefinitely.
  // huntersNeeded() uses the same getInvaderTargetRooms() internally; iterate the
  // list directly here so we can set per-room memory without a second call.
  for (const targetRoom of getInvaderTargetRooms(room)) {
    if (countCreepsByRoleAndTarget('hunter', targetRoom) > 0) continue;
    const hunterBody = buildHunterBody(room.energyCapacityAvailable);
    if (hunterBody.length > 0) {
      queue.push({
        role: 'hunter',
        body: hunterBody,
        minCount: countCreepsByRole('hunter', room.name) + 1,
        memory: {
          role: 'hunter' as CreepRoleName,
          homeRoom: room.name,
          targetRoom,
        },
      });
    }
  }

  if (isMinerEconomy) {
    // Miner economy: miners first (energy production), then haulers (distribution),
    // then harvesters as emergency bootstrap if both die, then upgraders/builders.
    const miners = minersNeeded(room);
    if (miners > 0) {
      queue.push({
        role: 'miner',
        body: buildMinerBody(room.energyCapacityAvailable),
        minCount: miners + countCreepsByRole('miner', room.name),
      });
    }
    queue.push({
      role: 'hauler',
      pattern: [CARRY, CARRY, MOVE, MOVE],
      maxRepeats: 8,
      minCount: haulersNeeded(room),
    });
    // Emergency bootstrap harvester: only needed while at least one source lacks a miner.
    // Retires automatically once all container sources are covered.
    queue.push({
      role: 'harvester',
      pattern: [WORK, CARRY, MOVE],
      maxRepeats: 4,
      minCount: minersNeeded(room) > 0 ? 1 : 0,
    });
    // Scale upgrader body to storage reserves: 5W below 15k, 10W below 50k, full above.
    const storedEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    const upgraderEnergyCap =
      storedEnergy < 15_000
        ? 600 // 5 WORK
        : storedEnergy < 50_000
          ? 1100 // 10 WORK
          : room.energyCapacityAvailable;
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
    // Colony expansion: claimer + colonyBuilder for any target room parented here.
    // Slotted ahead of remote mining because a colony in flight has a hard TTL
    // window (claimer dies after 600 ticks) and once it lands, the new room's
    // ROI dwarfs adding another remote.
    for (const { room: colonyRoom, state } of coloniesForHome(room.name)) {
      if (state.status === 'active') continue;

      if (state.status === 'claiming') {
        const liveClaimers = countCreepsByRoleAndTarget('claimer', colonyRoom);
        if (liveClaimers === 0) {
          const claimerBody = buildClaimerBody(room.energyCapacityAvailable);
          if (claimerBody.length > 0) {
            queue.push({
              role: 'claimer',
              body: claimerBody,
              minCount: countCreepsByRole('claimer', room.name) + 1,
              memory: {
                role: 'claimer' as CreepRoleName,
                homeRoom: room.name,
                targetRoom: colonyRoom,
              },
            });
          }
        }
      }

      if (state.status === 'bootstrapping') {
        const liveBuilders = countCreepsByRoleAndTarget('colonyBuilder', colonyRoom);
        const wanted = colonyBuildersWanted(colonyRoom);
        if (liveBuilders < wanted) {
          queue.push({
            role: 'colonyBuilder',
            pattern: [WORK, CARRY, MOVE, MOVE],
            maxRepeats: 4,
            minCount: countCreepsByRole('colonyBuilder', room.name) + (wanted - liveBuilders),
            memory: {
              role: 'colonyBuilder' as CreepRoleName,
              homeRoom: room.name,
              targetRoom: colonyRoom,
            },
          });
        }
      }
    }

    // Remote mining roles (lower priority than local economy)
    // Prespawn threshold: body spawn time (~33t) + cross-room travel (~80t) + buffer
    const REMOTE_MINER_PRESPAWN_TICKS = 150;
    const remoteRooms = mem?.remoteRooms ?? [];
    for (const remoteRoom of remoteRooms) {
      const remoteMem = Memory.rooms[remoteRoom];
      const isReserved = remoteMem?.remoteType === 'reserved';
      const remoteBody = buildRemoteMinerBody(room.energyCapacityAvailable, isReserved ? 10 : 5);
      if (remoteBody.length === 0) continue;
      const sourceCount = remoteMem?.sources?.length ?? remoteMem?.scoutedSources ?? 0;
      if (sourceCount === 0) continue;

      const existingRemoteMiners = countRemoteMiners(remoteRoom);
      const existingRemoteHaulers = countRemoteHaulers(remoteRoom);
      const totalMiners = countCreepsByRole('miner', room.name);
      const totalHaulers = countCreepsByRole('remoteHauler', room.name);

      // Spawn remote miners: 1 per source, prespawning when TTL is low so the
      // source is never left unmined between a miner dying and its replacement arriving.
      if (remoteMem?.sources) {
        for (const entry of remoteMem.sources) {
          const existingMiner = entry.minerName ? Game.creeps[entry.minerName] : undefined;
          // Skip if miner is alive with enough TTL to outlast a replacement's travel time
          if (
            existingMiner &&
            (existingMiner.ticksToLive ?? Infinity) >= REMOTE_MINER_PRESPAWN_TICKS
          )
            continue;
          // If dying or dead, skip if a replacement is already en route to this room
          const hasReplacement = Object.values(Game.creeps).some(
            (c) =>
              c.memory.role === 'miner' &&
              c.memory.targetRoom === remoteRoom &&
              c.name !== (entry.minerName ?? ''),
          );
          if (hasReplacement) continue;
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

      // Reserved rooms run 10-WORK miners (20 e/t) and are typically further away;
      // 3 haulers per source saturates throughput for ~100-tick round trips.
      // Plain remotes stay at 2 (shorter range, lower yield).
      const haulersWanted = sourceCount * (isReserved ? 3 : 2);
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

      // Reserver: 1 per reserved room (has a controller and we intend to keep it reserved)
      const remoteType = remoteMem?.remoteType ?? 'remote';
      if (remoteType === 'reserved' && countReservers(remoteRoom) === 0) {
        queue.push({
          role: 'reserver',
          body: [CLAIM, CLAIM, MOVE, MOVE],
          minCount: countCreepsByRole('reserver', room.name) + 1,
          memory: {
            role: 'reserver' as CreepRoleName,
            homeRoom: room.name,
            targetRoom: remoteRoom,
          },
        });
      }

      // Remote builder: only for reserved rooms (highway/remote rooms don't get road investment)
      if (remoteType === 'reserved' && remoteBuilderNeeded(remoteRoom)) {
        queue.push({
          role: 'remoteBuilder',
          pattern: [WORK, CARRY, MOVE, MOVE],
          maxRepeats: 4,
          minCount: countCreepsByRole('remoteBuilder', room.name) + 1,
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
  // Advance colony lifecycle states before any queue decisions so a newly-claimed
  // room flips to 'bootstrapping' on the same tick the claim lands.
  updateColonyStates();

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
    const hasDistributor =
      countCreepsByRole('hauler', room.name) > 0 || countCreepsByRole('harvester', room.name) > 0;
    const emergency = (mem?.minerEconomy ?? false) && !hasDistributor;

    for (const request of queue) {
      if (countCreepsByRole(request.role, room.name) >= request.minCount) continue;

      const spawn = room.find(FIND_MY_SPAWNS).find((s) => !s.spawning);
      if (!spawn) break;

      const energy = emergency ? room.energyAvailable : room.energyCapacityAvailable;
      const body =
        request.body !== undefined
          ? request.body
          : buildBody(request.pattern, energy, request.maxRepeats);
      if (body.length === 0) continue; // can't afford this role, try cheaper ones below

      const name = `${request.role}_${Game.time}`;
      const result = spawn.spawnCreep(body, name, {
        memory: request.memory ?? { role: request.role, homeRoom: room.name },
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
