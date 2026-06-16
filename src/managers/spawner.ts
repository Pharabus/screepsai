import {
  buildBody,
  buildHunterBody,
  buildKeeperKillerBody,
  buildMinerBody,
  buildRemoteMinerBody,
  buildUpgraderBody,
} from '../utils/body';
import { cached, getStructuresByType } from '../utils/tickCache';
import { defendersNeeded } from './defense';
import { threatScore } from '../utils/threat';
import { ensureRoomPlan, ensureRemoteRoomPlan, needsMineralMiner } from '../utils/roomPlanner';
import { selectRemoteRooms, remoteRoomCap } from '../utils/remotePlanner';
import { findScoutTarget } from '../roles/scout';
import { STORAGE_ENERGY_FLOOR } from '../utils/sources';
import {
  REPAIR_THRESHOLD,
  BOOST_LAB_MINERAL_TARGET,
  BOOST_LAB_MINERAL_MAINTAIN,
  HARVESTER_EMERGENCY_STORAGE_FLOOR,
} from '../utils/thresholds';
import { myStorage } from '../utils/ownership';
import { compoundInTransit } from '../utils/boost';
import { coloniesForHome, updateColonyStates, getColonyScore } from '../utils/colonyPlanner';
import {
  ensureRemoteMiningMission,
  syncMission,
  setMissionStatus,
  getActiveMissionHaulerCount,
  garbageCollectMissions,
  syncAllMissions,
  getRemoteMissionKey,
  STALL_HOSTILE_TICKS,
  getTransportMissions,
  getTransportMission,
  syncTransportMission,
} from '../utils/missions';
import { getNeighbor } from '../utils/neighbors';
import { energyBudget, colonyEnergy, upgradePower, upgraderWorkParts } from '../utils/economy';

const RESOURCE_GHODIUM_ACID = 'GH2O' as ResourceConstant;
const RESOURCE_KHO2 = 'KHO2' as ResourceConstant;
const RESOURCE_LHO2 = 'LHO2' as ResourceConstant;

/**
 * How many ticks to reuse a cached spawn queue when nothing needs spawning.
 *
 * buildSpawnQueue iterates Game.creeps for every *Needed() call (~12 checks × 3
 * rooms × ~46 creeps each) which accounts for ~2ms/tick of the spawner's 2ms
 * average. When all roles are at quota there is nothing to do for several ticks,
 * so we skip the rebuild and return the stale queue (which the spawn loop will
 * immediately skip because minCounts are still met). The cache is always bypassed
 * when emergency mode is detected or a defense mission is active.
 *
 * Heap-only: a global reset forces a full rebuild on the next tick (correct).
 * Value of 5 means a dead creep is detected within 5 ticks — well within the
 * pre-spawn TTL window so no coverage gap occurs.
 */
const QUEUE_CACHE_TICKS = 5;
const _queueCache = new Map<string, { tick: number; queue: SpawnRequest[] }>();

/** Reset the spawn queue cache — call in tests' beforeEach to prevent stale
 *  cached queues leaking between test cases that exercise runSpawner. */
export function resetSpawnQueueCache(): void {
  _queueCache.clear();
}

/**
 * Minimum colony score below which a young colony (RCL < 6) falls back to
 * the conservative single-upgrader path. A score of 0 means the room has no
 * active miners and no income to sustain extra drain; any positive income with
 * even a small storage buffer clears this gate comfortably.
 *
 * Score formula (see colonyPlanner.ts): rclFactor × incomeRate × storageFactor.
 * An RCL-4 room with 1 active source and 2k storage = 4 × 10 × 0.1 = 4 (below
 * threshold → conservative). With 2 active sources and 5k storage = 4 × 20 × 0.25
 * = 20 (at threshold → young path unlocked).
 */
const YOUNG_COLONY_MIN_SCORE = 20;

// Upper bound on haulers assigned to a single source. A very distant source
// (e.g. pathDist 100 across swamp) would otherwise demand 8+ haulers to move
// its 10 energy/tick; we cap coverage and accept some uncollected energy rather
// than saturate the spawn. The real fix for such sources is a road/tunnel that
// shortens the path.
const MAX_HAULERS_PER_SOURCE = 5;

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
  const roads = getStructuresByType(room)[STRUCTURE_ROAD] ?? [];
  return roads.some((s) => s.hits < s.hitsMax * 0.5);
}

/**
 * True when at least one local miner (no targetRoom) is in HARVEST state.
 * A miner in POSITION (travelling to container) produces no energy; the spawn
 * cannot fill up waiting for it, so callers treat this the same as "no producer".
 */
function hasActiveLocalMiner(room: Room): boolean {
  return cached('spawner:activeLocalMiner:' + room.name, () => {
    for (const c of Object.values(Game.creeps)) {
      if (
        c.memory.role === 'miner' &&
        c.memory.homeRoom === room.name &&
        !c.memory.targetRoom &&
        c.memory.state === 'HARVEST'
      )
        return true;
    }
    return false;
  });
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
 * Hauler count scaled to per-source round-trip distance.
 * Linked sources share one distribution hauler. Unlinked sources each get
 * ceil(dist*2*SOURCE_RATE / haulerCarry) haulers so energy doesn't pool.
 */
export function haulersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.sources) return 0;
  const withContainers = mem.sources.filter((s) => !!s.containerId);
  if (withContainers.length === 0) return 0;

  const haulerCarry = room.energyCapacityAvailable >= 800 ? 400 : 200;
  const SOURCE_RATE = 10; // energy/tick (3000 energy / 300-tick regen cycle)

  const linked = withContainers.filter(
    (s) => s.linkId && Game.getObjectById(s.linkId as Id<StructureLink>),
  );
  const unlinked = withContainers.filter(
    (s) => !(s.linkId && Game.getObjectById(s.linkId as Id<StructureLink>)),
  );

  let count = linked.length > 0 ? 1 : 0;

  for (const s of unlinked) {
    const dist = s.pathDist ?? 25;
    // Apply swamp correction for far sources: pathDist is plain-tile count but
    // high-dist paths typically traverse swamp, making hauler round-trips ~1.5x longer.
    const effectiveDist = dist > 60 ? Math.ceil(dist * 1.5) : dist;
    count += Math.min(
      MAX_HAULERS_PER_SOURCE,
      Math.max(1, Math.ceil((effectiveDist * 2 * SOURCE_RATE) / haulerCarry)),
    );
  }

  count = Math.max(count, 2);

  // +1 when mineral mining is active so the mineral container doesn't overflow
  if (mem.mineralId && mem.mineralContainerId) {
    const mineral = Game.getObjectById(mem.mineralId as Id<Mineral>);
    if (mineral && mineral.mineralAmount > 0) count += 1;
  }

  // +1 per active remote room: energy from remotes arrives in bulk and needs
  // dedicated bandwidth to distribute before the source containers fill up.
  count += mem.remoteRooms?.length ?? 0;

  return count;
}

/**
 * Upgrader count. Branches on colony maturity:
 *
 * BOOTSTRAP (no miner economy): keep 2 so containers get built quickly.
 *
 * YOUNG COLONY (RCL < 6): invest own income aggressively to accelerate RCL.
 *   Safety constraints:
 *   (a) Income-gated: only push harder when colony score ≥ YOUNG_COLONY_MIN_SCORE
 *       (ensures miners/haulers are covering income before we add drain).
 *   (b) Hard floor: at stored < 5k, keep exactly 1 small upgrader — never 0,
 *       so the controller still progresses; never more, to protect spawn energy.
 *   (c) Don't starve builders: when construction sites exist AND storage is
 *       below 20k, cap at 1 so builders also get spawn time. Upgrading alone
 *       won't level the room if the RCL-5 links / RCL-6 structures aren't built.
 *
 * MATURE COLONY (RCL 6+): ramp starts at 50k now that FACTORY_ENERGY_FLOOR
 *   has been raised to 120k. Previously the factory consumed everything above
 *   50k into batteries, so storage never climbed to the old 100k threshold and
 *   W43N58 was permanently stuck at 1 upgrader. With the factory floor raised
 *   above the upgrader band, the surplus that should fund extra upgraders is no
 *   longer intercepted, so we can lower the ramp thresholds and favour RCL8
 *   progress over battery credit income.
 */
export function upgradersNeeded(room: Room): number {
  const mem = Memory.rooms[room.name];
  if (!mem?.minerEconomy) return 2;

  const rcl = room.controller?.level ?? 0;
  const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;

  // (b) Hard floor: applies to all economy levels
  if (room.storage && stored < 5_000) {
    return rcl < 8 ? 1 : 0;
  }

  // YOUNG COLONY (RCL 1-5): invest own income aggressively
  if (rcl < 6) {
    // (a) Income gate: score below threshold → conservative single upgrader
    const score = getColonyScore(room);
    if (score < YOUNG_COLONY_MIN_SCORE) return 1;

    // (c) Builder starvation guard: limit upgraders when sites need spawn time too
    const sites = cached(
      'spawner:sites:' + room.name,
      () => room.find(FIND_MY_CONSTRUCTION_SITES).length,
    );
    if (sites > 0 && stored < 20_000) return 1;

    // Healthy income, no construction bottleneck: push harder toward next RCL
    if (stored < 15_000) return 2;
    if (stored < 40_000) return 3;
    return 4;
  }

  // MATURE COLONY (RCL 6+):
  if (Memory.holisticEconomy) {
    // Continuous formula: ceil(upgradePower / upgraderWorkParts), clamped [1, 4].
    // upgradePower scales monotonically with colonyEnergy (storage + terminal)
    // above the RCL buffer, so there are no step-function cliffs and the count
    // never drops as energy increases. The hard floor min of 1 is preserved for
    // all non-RCL8 rooms (RCL8 is handled by the hard-floor block above when
    // stored < 5k; above that, min=1 is benign — controller can still accept input).
    // See src/utils/economy.ts for formula, constants, and calibration examples.
    const wParts = Math.max(1, upgraderWorkParts(room));
    const power = upgradePower(room);
    const n = Math.ceil(power / wParts);
    return Math.min(Math.max(1, n), 4);
  }
  // Flag-off: existing literal step ramp (unchanged).
  // ramp starts at 50k; factory floor (120k) sits above this band so batteries
  // only form from genuine surplus.
  if (stored < 50_000) return 1;
  if (stored < 150_000) return 2;
  if (stored < 400_000) return 3;
  return 4;
}

/**
 * Builder count scales with active construction sites. At least 1 (they fall
 * back to upgrading when idle), up to 3 when there's heavy construction.
 */
export function buildersNeeded(room: Room): number {
  // Controller emergency: stop draining energy on construction when near downgrade
  const ctrl = room.controller;
  if (ctrl && ctrl.ticksToDowngrade < 10_000 && ctrl.level < 5) return 0;

  const storage = room.storage;
  const mem = Memory.rooms[room.name];
  const sources = mem?.sources;
  const allSourcesLinked =
    sources !== undefined && sources.length > 0 && sources.every((s) => s.linkId);
  // Energy gate: suppress builders when storage is too low.
  // Under holisticEconomy, count storage + terminal energy so a room with
  // combined energy above the floor still spawns builders.
  // Flag-off: existing storage-only check (unchanged).
  // The sites===0 early return below is preserved regardless of flag.
  if (Memory.holisticEconomy) {
    if (storage && allSourcesLinked && colonyEnergy(room) < STORAGE_ENERGY_FLOOR) return 0;
  } else {
    if (
      storage &&
      allSourcesLinked &&
      storage.store.getUsedCapacity(RESOURCE_ENERGY) < STORAGE_ENERGY_FLOOR
    )
      return 0;
  }

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
  const damaged = cached('spawner:damaged:' + room.name, () => {
    const structs = getStructuresByType(room);
    let count = 0;
    for (const [type, list] of Object.entries(structs) as [StructureConstant, Structure[]][]) {
      if (type === STRUCTURE_WALL || type === STRUCTURE_RAMPART) continue;
      for (const s of list) {
        if (s.hits < s.hitsMax * REPAIR_THRESHOLD) count++;
      }
    }
    return count;
  });
  if (damaged === 0) return 0;
  if (damaged > 5) return 2;
  return 1;
}

export function mineralMinersNeeded(room: Room): number {
  const rcl = room.controller?.level ?? 0;
  if (rcl < 6) return 0;
  // Check if extractor is built
  const hasExtractor =
    room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTRACTOR,
    }).length > 0;
  if (!hasExtractor) return 0;
  if (Memory.holisticEconomy) {
    // Holistic path: mine only when surplus exceeds buffer + reserve margin.
    // The MINERAL_RESERVE_MARGIN (15k) is deliberately != any upgrader threshold
    // — this structurally prevents the collision where mining and upgrader gates
    // coincide at the same energy level, starving the miner of a stable window.
    // See src/utils/economy.ts allowMineralMining for gate formula.
    if (!energyBudget(room).allowMineralMining) return 0;
  } else {
    // Flag-off: existing literal storage-only thresholds (unchanged).
    // RCL 7+ has a mature enough economy to support the ~1.7 energy/tick overhead
    // of mineral mining at a lower reserve threshold; credits from mineral sales
    // fuel lab buying before 100k storage is reached.
    // RCL 6 floor lowered from 100k → 50k: W44N57 storage oscillates ~43k–60k,
    // so 100k was never crossed, leaving 35k O unmined. At 50k, surplus windows
    // trigger a spawn (long TTL miner persists through dips), so O gets mined even
    // intermittently crossing the threshold.
    const floor = rcl >= 7 ? 70_000 : 50_000;
    const stored = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    if (stored < floor) return 0;
  }
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

  const hostiles = cached('defense:hostiles:' + room.name, () => room.find(FIND_HOSTILE_CREEPS));
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

/**
 * How many remoteHaulers are needed for a single remote room.
 * Uses cached round-trip distance (ticks) to scale beyond the flat baseline.
 * Falls back to the flat formula when distance has not been cached yet.
 *
 * Formula: Math.max(flat, ceil(roundTripTicks × sourceRate / carryCapacity)) × sourceCount
 *   flat         : existing lower bound (3 reserved, 2 unreserved) — never regress
 *   sourceRate   : energy/tick per source (10 reserved, 5 unreserved)
 *   carryCapacity: total CARRY from the actual hauler body built for this room
 */
export function remoteHaulersWanted(
  room: Room,
  remoteRoom: string,
  sourceCount: number,
  isHighCapacity: boolean,
): number {
  const flatPerSource = isHighCapacity ? 3 : 2;
  const roundTripTicks = Memory.rooms[room.name]?.remoteDistance?.[remoteRoom];
  if (roundTripTicks === undefined) {
    return sourceCount * flatPerSource; // flat fallback — distance not cached yet
  }
  const sourceRate = isHighCapacity ? 10 : 5;
  const haulerBody = buildBody([CARRY, CARRY, MOVE, MOVE], room.energyCapacityAvailable, 8);
  const carryCapacity = haulerBody.filter((p) => p === CARRY).length * 50;
  if (carryCapacity === 0) return sourceCount * flatPerSource;
  const haulersPerSource = Math.min(
    MAX_HAULERS_PER_SOURCE,
    Math.max(flatPerSource, Math.ceil((roundTripTicks * sourceRate) / carryCapacity)),
  );
  return haulersPerSource * sourceCount;
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

  for (const { state } of coloniesForHome(homeRoom.name)) {
    // Always watch transit rooms regardless of colony status — inter-colony
    // traffic continues to traverse them after the colony goes active.
    for (const transit of state.transitRooms ?? []) {
      if (hasActiveInvader(transit) && !targets.includes(transit)) targets.push(transit);
    }
  }

  return targets;
}

/** Count of unique invader-infested rooms that still need a hunter. */
export function huntersNeeded(homeRoom: Room): number {
  return getInvaderTargetRooms(homeRoom).length;
}

/** SK rooms (in remoteRooms) that need a keeper killer from this colony. */
function getKeeperTargetRooms(home: Room): string[] {
  return (Memory.rooms[home.name]?.remoteRooms ?? []).filter(
    (r) => !!Memory.rooms[r]?.scoutedHasKeepers,
  );
}

/**
 * Count of SK-flagged remote rooms that lack an assigned keeper killer.
 * Returns 0 when energyCapacityAvailable < 5300 (body can't be built).
 */
export function keeperKillersNeeded(home: Room): number {
  if (home.energyCapacityAvailable < 5300) return 0;
  return getKeeperTargetRooms(home).filter(
    (targetRoom) =>
      !Object.values(Game.creeps).some(
        (c) =>
          c.memory.role === 'keeperKiller' &&
          c.memory.targetRoom === targetRoom &&
          c.memory.homeRoom === home.name,
      ),
  ).length;
}

/**
 * Returns true when all conditions for boosting upgraders with GH2O are met:
 *  1. RCL 7+ (at RCL 6, reserving the only output lab would halt reactions)
 *  2. At least 2 output labs available (inputLabIds has 2, labIds has ≥2 non-input labs)
 *  3. GH2O stock ≥ threshold. The stock sums storage + terminal + reserved boost
 *     lab + in-transit (compound carried by haulers en route to the lab). The
 *     threshold is HYSTERETIC: BOOST_LAB_MINERAL_TARGET (1500) to first reserve,
 *     but only BOOST_LAB_MINERAL_MAINTAIN (500) to keep an existing reservation.
 *  4. Storage energy > STORAGE_ENERGY_FLOOR (10k) — don't boost while energy-starved
 *
 * Why both the in-transit term and the hysteresis matter — two distinct flip-flops:
 *  - In-transit: filling the lab moves up to 1500 GH2O out of storage into haulers
 *    then the lab. A storage-only sum dips below 1500 the instant a hauler grabs the
 *    compound, unreserving the lab mid-fill so it can never be filled (observed live
 *    W43N58: upgraders never boosted because filling the lab tripped its own gate).
 *    Counting in-transit + lab keeps the sum invariant across the storage→lab move.
 *  - Hysteresis: a single boost consumes ~450 GH2O from the lab (30/part × ~15 work),
 *    which permanently reduces the total. Without a lower maintain floor that drop
 *    would unreserve the lab after every boost, stranding the next upgrader. The 500
 *    floor sits just above one boost's worth so boosting continues until stock is
 *    genuinely depleted, then resumes once reactions/market rebuild it past 1500.
 */
export function upgraderBoostWanted(room: Room): boolean {
  if (!room.controller || room.controller.level < 7) return false;

  const mem = Memory.rooms[room.name];
  if (!mem) return false;

  const inputLabCount = mem.inputLabIds?.length ?? 0;
  const totalLabCount = mem.labIds?.length ?? 0;
  const outputLabCount = totalLabCount - inputLabCount;
  if (inputLabCount < 2 || outputLabCount < 2) return false;

  const gh2oInStorage = room.storage?.store.getUsedCapacity(RESOURCE_GHODIUM_ACID) ?? 0;
  const gh2oInTerminal = room.terminal?.store.getUsedCapacity(RESOURCE_GHODIUM_ACID) ?? 0;
  let gh2oInBoostLab = 0;
  if (mem.boostLabId) {
    const boostLab = Game.getObjectById(mem.boostLabId);
    if (boostLab && boostLab.mineralType === RESOURCE_GHODIUM_ACID) {
      gh2oInBoostLab = boostLab.store.getUsedCapacity(RESOURCE_GHODIUM_ACID) ?? 0;
    }
  }
  const gh2oInTransit = compoundInTransit(room, RESOURCE_GHODIUM_ACID);
  const totalGh2o = gh2oInStorage + gh2oInTerminal + gh2oInBoostLab + gh2oInTransit;
  // Hysteresis: keep an already-reserved lab down to the maintain floor; only
  // require the full target to (re)reserve from scratch.
  const threshold = mem.boostLabId ? BOOST_LAB_MINERAL_MAINTAIN : BOOST_LAB_MINERAL_TARGET;
  if (totalGh2o < threshold) return false;

  const storedEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (storedEnergy <= STORAGE_ENERGY_FLOOR) return false;

  return true;
}

/**
 * Reserves or releases the boost lab for upgrader GH2O boosting.
 * When upgraderBoostWanted: ensures boostLabId points to a valid output lab and
 * sets boostCompound = GH2O.
 * When not wanted: clears both fields so the lab rejoins reactions.
 * Must be called every tick so the hauler keeps the lab topped.
 */
export function reserveBoostLab(room: Room): void {
  const mem = Memory.rooms[room.name];
  if (!mem) return;

  if (!upgraderBoostWanted(room)) {
    delete mem.boostLabId;
    delete mem.boostCompound;
    return;
  }

  const inputLabSet = new Set<string>(mem.inputLabIds ?? []);
  const outputLabIds = (mem.labIds ?? []).filter((id) => !inputLabSet.has(id));

  // Validate existing boostLabId
  if (mem.boostLabId) {
    const existing = Game.getObjectById(mem.boostLabId);
    if (existing && !inputLabSet.has(mem.boostLabId)) {
      // Still valid — keep it and ensure compound is set
      mem.boostCompound = RESOURCE_GHODIUM_ACID;
      return;
    }
    // Invalid or became an input lab — fall through to pick a new one
    delete mem.boostLabId;
  }

  // Pick a stable output lab — prefer one whose mineralType is null or already GH2O;
  // otherwise the first output lab by id order (deterministic, avoid churn).
  const sortedOutputLabIds = outputLabIds.slice().sort();
  let chosen: Id<StructureLab> | undefined;

  // First pass: prefer a lab already loaded with GH2O or empty
  for (const id of sortedOutputLabIds) {
    const lab = Game.getObjectById(id as Id<StructureLab>);
    if (!lab) continue;
    if (!lab.mineralType || lab.mineralType === RESOURCE_GHODIUM_ACID) {
      chosen = id as Id<StructureLab>;
      break;
    }
  }

  // Second pass: fall back to first valid output lab
  if (!chosen) {
    for (const id of sortedOutputLabIds) {
      const lab = Game.getObjectById(id as Id<StructureLab>);
      if (lab) {
        chosen = id as Id<StructureLab>;
        break;
      }
    }
  }

  if (chosen) {
    mem.boostLabId = chosen;
    mem.boostCompound = RESOURCE_GHODIUM_ACID;
  }
}

/**
 * Returns true when boosting defenders is worthwhile: RCL 7+ AND at least one
 * hostile creep owned by a player classified as 'aggressive' is currently in
 * the room. Invaders and Source Keepers are excluded — they don't warrant
 * spending boost compound.
 *
 * ensureBoosted fails open when the compound isn't stocked, so attaching boosts
 * is opportunistic and never stalls a defender that spawns before stock arrives.
 */
export function defenderBoostsWanted(room: Room): boolean {
  if ((room.controller?.level ?? 0) < 7) return false;
  const hostiles = cached('defense:hostiles:' + room.name, () => room.find(FIND_HOSTILE_CREEPS));
  for (const creep of hostiles) {
    const owner = creep.owner?.username;
    if (!owner || owner === 'Invader' || owner === 'Source Keeper') continue;
    if (getNeighbor(owner)?.hostility === 'aggressive') return true;
  }
  return false;
}

export function buildSpawnQueue(room: Room): SpawnRequest[] {
  const queue: SpawnRequest[] = [];
  const mem = Memory.rooms[room.name];
  const isMinerEconomy = mem?.minerEconomy ?? false;

  // Priority 0: Defenders (dynamic, only when threat active)
  const comp = defenderComposition(room);
  // Annotate the active defense mission with the quota we're working toward
  // (disjoint field; defense.ts owns the rest of the record — avoids a circular
  // import between defense.ts and spawner.ts).
  const defenseMission = Memory.missions?.defense?.[room.name];
  if (defenseMission && defenseMission.status === 'active') defenseMission.composition = comp;
  const wantDefenderBoosts =
    comp.melee > 0 || comp.ranged > 0 || comp.healer > 0 ? defenderBoostsWanted(room) : false;
  if (comp.melee > 0) {
    // No boost for melee: [ATTACK, MOVE] body has no TOUGH parts to benefit from
    // defensive compounds. ensureBoosted is wired in the role and will no-op.
    queue.push({ role: 'defender', pattern: [ATTACK, MOVE], minCount: comp.melee });
  }
  if (comp.ranged > 0) {
    queue.push({
      role: 'rangedDefender',
      pattern: [RANGED_ATTACK, MOVE],
      maxRepeats: 5,
      minCount: comp.ranged,
      ...(wantDefenderBoosts
        ? {
            memory: {
              role: 'rangedDefender' as CreepRoleName,
              homeRoom: room.name,
              boosts: [{ part: RANGED_ATTACK, compound: RESOURCE_KHO2 }],
            },
          }
        : {}),
    });
  }
  if (comp.healer > 0) {
    queue.push({
      role: 'healer',
      pattern: [HEAL, MOVE],
      maxRepeats: 4,
      minCount: comp.healer,
      ...(wantDefenderBoosts
        ? {
            memory: {
              role: 'healer' as CreepRoleName,
              homeRoom: room.name,
              boosts: [{ part: HEAL, compound: RESOURCE_LHO2 }],
            },
          }
        : {}),
    });
  }

  // Priority 0.5: Dismantler — one-off structure removal for pre-claim obstacle
  // clearing (e.g. a tower blocking the room controller). Spawned once when
  // Memory.dismantleTarget names this room as the home. Clears itself on completion.
  if (Memory.dismantleTarget?.homeRoom === room.name) {
    if (countCreepsByRole('dismantler', room.name) === 0) {
      queue.push({
        role: 'dismantler',
        body: [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE],
        minCount: 1,
        memory: {
          role: 'dismantler' as CreepRoleName,
          homeRoom: room.name,
          targetRoom: Memory.dismantleTarget.room,
        },
      });
    }
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

  // Priority 2: Keeper killers for SK rooms — queued before miners so Source Keeper
  // rooms stay clear and don't block remote energy production indefinitely.
  for (const targetRoom of getKeeperTargetRooms(room)) {
    const hasKiller = Object.values(Game.creeps).some(
      (c) =>
        c.memory.role === 'keeperKiller' &&
        c.memory.targetRoom === targetRoom &&
        c.memory.homeRoom === room.name,
    );
    if (hasKiller) continue;
    const keeperBody = buildKeeperKillerBody(room.energyCapacityAvailable);
    if (!keeperBody) continue;
    queue.push({
      role: 'keeperKiller',
      body: keeperBody,
      minCount: countCreepsByRole('keeperKiller', room.name) + 1,
      memory: {
        role: 'keeperKiller' as CreepRoleName,
        homeRoom: room.name,
        targetRoom,
      },
    });
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
    // Emergency bootstrap harvester: queued before hauler so the first creep
    // spawned during recovery has WORK parts and can actually harvest from
    // sources. A hauler alone cannot generate energy. Gated on BOTH a
    // miner-coverage gap (a source lacks a miner, or no local miner is actively
    // harvesting) AND a genuine low-energy state (own storage below
    // HARVESTER_EMERGENCY_STORAGE_FLOOR). A mature room with a full storage rides
    // out a routine miner-replacement gap on its buffer — haulers refill the spawn
    // from storage and the replacement miner arrives shortly — so it must NOT
    // spawn a harvester every time a miner cycles. Harvesters are emergency
    // low-energy bootstrappers, not a fixture of energy-rich rooms.
    const minerGap = minersNeeded(room) > 0 || !hasActiveLocalMiner(room);
    const lowBuffer =
      (myStorage(room)?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) <
      HARVESTER_EMERGENCY_STORAGE_FLOOR;
    queue.push({
      role: 'harvester',
      pattern: [WORK, CARRY, MOVE],
      maxRepeats: 4,
      minCount: minerGap && lowBuffer ? 1 : 0,
    });
    queue.push({
      role: 'hauler',
      pattern: [CARRY, CARRY, MOVE, MOVE],
      maxRepeats: 8,
      minCount: haulersNeeded(room),
    });
    // Scale upgrader body to storage reserves.
    // Young colonies (RCL < 6) use lower storage thresholds so they build a
    // larger body sooner — investing income aggressively rather than hoarding.
    // Mature rooms (RCL 6+) keep the conservative 600/1100/full tiers that
    // prevent a 15-WORK upgrader from draining storage faster than miners fill it.
    //
    // Cap at energyCapacityAvailable so the body never exceeds what the room
    // can actually spawn (e.g. RCL 1 post-downgrade has only 300 capacity).
    const storedEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
    const isCtrlEmergency = !!(
      room.controller &&
      room.controller.ticksToDowngrade < 10_000 &&
      room.controller.level < 5
    );
    const isYoungColony = (room.controller?.level ?? 0) < 6;
    const upgraderEnergyCap = Math.min(
      isCtrlEmergency
        ? room.energyCapacityAvailable
        : isYoungColony
          ? storedEnergy < 5_000
            ? 600 // minimal — hard floor, keep body cheap
            : storedEnergy < 15_000
              ? 1100 // 10 WORK — invest harder once storage builds
              : room.energyCapacityAvailable // full body above 15k
          : storedEnergy < 15_000
            ? 600 // mature: 5 WORK — conservative below 15k
            : storedEnergy < 50_000
              ? 1100 // 10 WORK below 50k
              : room.energyCapacityAvailable, // full above 50k
      room.energyCapacityAvailable,
    );
    queue.push({
      role: 'upgrader',
      body: buildUpgraderBody(upgraderEnergyCap),
      minCount: upgradersNeeded(room),
      ...(upgraderBoostWanted(room)
        ? {
            memory: {
              role: 'upgrader' as CreepRoleName,
              homeRoom: room.name,
              boosts: [{ part: WORK, compound: RESOURCE_GHODIUM_ACID }],
            },
          }
        : {}),
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
      const isKeeperRoom = remoteMem?.remoteType === 'keeperRoom';
      const isHighCapacity = isReserved || isKeeperRoom;
      const remoteBody = buildRemoteMinerBody(
        room.energyCapacityAvailable,
        isHighCapacity ? 10 : 5,
      );
      if (remoteBody.length === 0) continue;
      const scoutedCount =
        remoteMem?.scoutedSourceData?.length ??
        (typeof remoteMem?.scoutedSources === 'number' ? remoteMem.scoutedSources : 0);
      const sourceCount = remoteMem?.sources?.length ?? scoutedCount;
      if (sourceCount === 0) continue;

      const existingRemoteMiners = countRemoteMiners(remoteRoom);
      const totalMiners = countCreepsByRole('miner', room.name);
      const totalHaulers = countCreepsByRole('remoteHauler', room.name);

      // Sync mission record and detect stall (active hostiles suppress new spawns)
      const mission = ensureRemoteMiningMission(room.name, remoteRoom);
      syncMission(remoteRoom);
      const hostileLastSeen = remoteMem?.hostileLastSeen ?? 0;
      const isStalled = hostileLastSeen > 0 && Game.time - hostileLastSeen < STALL_HOSTILE_TICKS;
      if (isStalled && mission.status !== 'stalled') {
        setMissionStatus(remoteRoom, 'stalled');
      } else if (!isStalled && mission.status === 'stalled') {
        setMissionStatus(remoteRoom, 'active');
      }

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
          const hasReplacement = cached(
            'spawner:hasReplacement:' + remoteRoom + ':' + entry.id,
            () =>
              Object.values(Game.creeps).some(
                (c) =>
                  c.memory.role === 'miner' &&
                  c.memory.targetRoom === remoteRoom &&
                  c.name !== (entry.minerName ?? ''),
              ),
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

      const haulersWanted = remoteHaulersWanted(room, remoteRoom, sourceCount, isHighCapacity);
      // Don't spawn remote haulers until the remote miner has built at least one
      // source container. Before that the miner spends its output building the
      // container (1 CARRY) and produces little to haul — pre-spawned haulers
      // would just idle/round-trip for nothing. containerId is set by the miner
      // (miner.ts) and ensureRemoteRoomPlan once the container exists.
      const remoteContainerBuilt = remoteMem?.sources?.some((s) => !!s.containerId) ?? false;
      // Use mission-tracked hauler count instead of a live scan. syncMission() above
      // already refreshed mission.haulerIds, so this is O(1). Stalled remotes skip
      // spawning so we don't send creeps into a hostile room.
      const activeHaulers = getActiveMissionHaulerCount(remoteRoom);
      if (!isStalled && remoteContainerBuilt && activeHaulers < haulersWanted) {
        queue.push({
          role: 'remoteHauler',
          pattern: [CARRY, CARRY, MOVE, MOVE],
          maxRepeats: 8,
          minCount: totalHaulers + 1,
          memory: {
            role: 'remoteHauler' as CreepRoleName,
            homeRoom: room.name,
            targetRoom: remoteRoom,
            missionId: getRemoteMissionKey(remoteRoom),
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
            missionId: getRemoteMissionKey(remoteRoom),
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
    // Scout: only when the colony still has remote-room capacity to fill AND
    // there's a room to explore. A colony already at its storage-gated remote
    // cap gains nothing from more remotes, so it must not burn spawn bandwidth
    // re-scouting depth-3 territory it cannot exploit. Drops below cap again
    // (e.g. a remote lost or storage grown) automatically resume scouting.
    const remoteCount = mem?.remoteRooms?.length ?? 0;
    if (remoteCount < remoteRoomCap(room) && findScoutTarget(room.name)) {
      queue.push({
        role: 'scout',
        pattern: [MOVE],
        maxRepeats: 1,
        minCount: 1,
        memory: { role: 'scout' as CreepRoleName, homeRoom: room.name },
      });
    }
  } else {
    // Bootstrap economy: builders before upgraders so containers get built quickly
    queue.push({ role: 'harvester', pattern: [WORK, CARRY, MOVE], minCount: 2 });
    queue.push({ role: 'builder', pattern: [WORK, CARRY, MOVE], minCount: buildersNeeded(room) });
    queue.push({ role: 'repairer', pattern: [WORK, CARRY, MOVE], minCount: repairersNeeded(room) });
    queue.push({ role: 'upgrader', pattern: [WORK, CARRY, MOVE], minCount: 1 });
  }

  // Transport missions (operator-created via deliverEnergy): couriers spawn from
  // the DESTINATION room — the natural empty→source→full→dest loop, and the dest
  // is a mature colony with ample spawn capacity. Added last (lowest priority):
  // a manual transport must never starve the local economy or defenders.
  for (const t of getTransportMissions()) {
    if (t.destRoom !== room.name || t.status === 'retiring') continue;
    syncTransportMission(t.id);
    // Re-fetch: syncTransportMission may have flipped status to 'retiring'.
    const m = getTransportMission(t.id);
    if (!m || m.status === 'retiring') continue;
    const carried = m.courierIds.reduce((sum, name) => {
      const c = Game.creeps[name];
      return sum + (c ? c.store.getUsedCapacity(m.resource) : 0);
    }, 0);
    if (m.deliveredAmount + carried >= m.targetAmount) continue;
    const dist = Game.map.getRoomLinearDistance(room.name, m.sourceRoom);
    // Linear distance under-provisions diagonal neighbours: W42N59↔W43N58 are
    // Chebyshev dist=1 but share no border, so the real route detours through a
    // third room (~165-tile round trip). 1+dist gave only 2 couriers and a
    // ~24 e/tick drain. 2+dist (3 for adjacent, capped at 4) roughly doubles
    // throughput; still lowest-priority so it never starves the local economy.
    const courierCap = Math.min(4, 2 + dist);
    if (m.courierIds.length >= courierCap) continue;
    queue.push({
      role: 'courier',
      pattern: [CARRY, CARRY, MOVE, MOVE],
      maxRepeats: 8,
      minCount: countCreepsByRole('courier', room.name) + 1,
      memory: {
        role: 'courier' as CreepRoleName,
        homeRoom: room.name, // destination
        targetRoom: m.sourceRoom,
        missionId: m.id,
      },
    });
  }

  return queue;
}

export function runSpawner(): void {
  // Advance colony lifecycle states before any queue decisions so a newly-claimed
  // room flips to 'bootstrapping' on the same tick the claim lands.
  updateColonyStates();

  // Prune stale mission records once every 100 ticks (cheap — only touches retiring missions)
  if (Game.time % 100 === 0) garbageCollectMissions();

  // Ensure room plans are up to date before making spawn decisions
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) {
      ensureRoomPlan(room);
      // Periodically re-evaluate remote room selection
      if (Game.time % 100 === 0) {
        selectRemoteRooms(room);
        // Retire missions for any remotes that selectRemoteRooms just removed
        syncAllMissions(room.name, Memory.rooms[room.name]?.remoteRooms ?? []);
      }
      // Scan remote rooms we have visibility into
      const remoteRooms = Memory.rooms[room.name]?.remoteRooms ?? [];
      for (const remoteName of remoteRooms) {
        ensureRemoteRoomPlan(remoteName);
      }
    }
  }

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;

    // Reserve or release the boost lab every tick so the hauler keeps it topped.
    reserveBoostLab(room);

    // Emergency recovery: build bodies from energyAvailable instead of capacity
    // when the spawn cannot accumulate to capacity on its own.
    // Case 1 — no distributors: haulers/harvesters fill extensions; without them
    //   energyAvailable is permanently capped at spawn-only levels.
    // Case 2 — no active producer: haulers exist but nothing is harvesting (e.g.
    //   the only miner is still travelling to its container), so the spawn itself
    //   will never fill. Harvesters count as both distributor and producer; a miner
    //   in POSITION state counts as neither.
    // Computed before the queue so the cache can be bypassed in emergency.
    const hasDistributor =
      countCreepsByRole('hauler', room.name) > 0 || countCreepsByRole('harvester', room.name) > 0;
    const hasActiveProducer =
      countCreepsByRole('harvester', room.name) > 0 || hasActiveLocalMiner(room);
    const emergency = !hasDistributor || !hasActiveProducer;

    // Cache the spawn queue for QUEUE_CACHE_TICKS when the room is fully staffed.
    // Bypassed when emergency (need immediate response) or a defense mission is
    // active (threat composition changes every tick). The cache is heap-only so a
    // global reset forces a full rebuild — which is the correct behaviour.
    const hasActiveThreat = Memory.missions?.defense?.[room.name]?.status === 'active';
    let queue: SpawnRequest[];
    const cached_q = _queueCache.get(room.name);
    if (
      !emergency &&
      !hasActiveThreat &&
      cached_q &&
      Game.time - cached_q.tick < QUEUE_CACHE_TICKS
    ) {
      queue = cached_q.queue;
    } else {
      queue = buildSpawnQueue(room);
      _queueCache.set(room.name, { tick: Game.time, queue });
    }

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

      const name = `${request.role}_${room.name}_${Game.time}`;
      const result = spawn.spawnCreep(body, name, {
        memory: request.memory ?? { role: request.role, homeRoom: room.name },
      });

      if (result === OK) {
        console.log(`Spawning ${request.role} (${body.length} parts): ${name}`);
        break; // one spawn per room per tick
      } else if (result === ERR_NOT_ENOUGH_ENERGY) {
        // In emergency mode extensions can't be filled (no distributors), so
        // energyAvailable is permanently capped at spawn-only levels. Skip to
        // the next (cheaper) request instead of waiting forever.
        if (emergency) continue;
        break;
      } else {
        console.log(`Spawn error for ${request.role}: ${result}`);
      }
    }
  }
}
