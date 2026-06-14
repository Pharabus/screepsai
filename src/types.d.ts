type CreepRoleName =
  | 'harvester'
  | 'upgrader'
  | 'builder'
  | 'repairer'
  | 'defender'
  | 'rangedDefender'
  | 'healer'
  | 'miner'
  | 'hauler'
  | 'mineralMiner'
  | 'scout'
  | 'remoteHauler'
  | 'reserver'
  | 'remoteBuilder'
  | 'claimer'
  | 'colonyBuilder'
  | 'hunter'
  | 'keeperKiller'
  | 'courier'
  | 'dismantler';

interface CreepMemory {
  role: CreepRoleName;
  /** Desired boosts to apply before the creep starts its role; consumed by ensureBoosted() in src/utils/boost.ts. Entries are removed as applied; the field is deleted once all are done (or on fail-open). */
  boosts?: { part: BodyPartConstant; compound: ResourceConstant }[];
  /** Tick at which the creep first started waiting in range of the boost lab for an absent compound. Used by ensureBoosted() to bound the wait and fail open rather than idling forever. Cleared on success/fail-open. */
  boostWaitStart?: number;
  /** ID of the assigned target (source, container, controller, mineral, etc.) */
  targetId?: Id<
    | Source
    | Mineral
    | Resource
    | Ruin
    | Tombstone
    | StructureContainer
    | StructureStorage
    | StructureTerminal
    | StructureController
    | StructureSpawn
    | StructureExtension
    | StructureTower
    | StructureLink
    | StructureLab
    | StructureFactory
  >;
  /** FSM state name */
  state?: string;
  /** Room the creep was spawned in / belongs to (set for remote roles) */
  homeRoom?: string;
  /** Target room for cross-room movement (scout, remote roles) */
  targetRoom?: string;
  /** Tick when scout started pathing to current target (stuck detection) */
  _scoutTick?: number;
  /** Name of a friendly combat creep this healer is paired with */
  partnerName?: string;
  /** Game tick when the current idle streak began (used by idle.ts for recycle thresholds) */
  idleSince?: number;
  /** Last tick markIdle was called — detects streak breaks without touching role code */
  _idleLastTick?: number;
  /** Movement priority used by pushBlocker — higher priority creeps may push lower-priority blockers */
  movePriority?: number;
  /**
   * Mission this creep is assigned to — set at spawn time for remote haulers and reservers.
   * Format: 'remoteMining:<roomName>'. Used by missions.ts to scan live creeps and keep
   * RemoteMiningMission.haulerIds / reserverId in sync without needing spawn callbacks.
   */
  missionId?: string;
}

// Per-room persistent memory. Managers extend this as they need cold data
// (planned structure positions, cached source ids, threat tracking, stats).
interface RoomMemory {
  // Defense (src/managers/defense.ts)
  threatLastSeen?: number;
  lastThreatScore?: number;
  /**
   * True while an attack is in progress (hostiles present this tick).
   * Used by combatLog.ts to detect threat_appeared / threat_ended transitions
   * and to gate one-shot per-combat log events.
   */
  combatActive?: boolean;
  /** Game.time when combatActive was first set — used to compute duration in threat_ended. */
  combatStartedAt?: number;
  /** Cleared at combat start; set once a safe_mode_unavailable event is logged this combat. */
  combatSafeModeLogged?: boolean;
  /** Cleared at combat start; set once a tower_energy_low event is logged this combat. */
  combatTowerDrainLogged?: boolean;
  // Remote room threat — set by any creep that spots a hostile in this room.
  // Used by remote roles to flee and stay home until the threat clears.
  hostileLastSeen?: number;
  /** True if the last remote-room hostile sighting was a player (long cooldown); NPC-only sightings use a short cooldown. */
  hostileLastWasPlayer?: boolean;
  // NPC Invader presence — set/cleared by defense manager and hunter role.
  // Used by spawner to queue hunters for remote/transit rooms.
  invaderSeenAt?: number;
  // Room planning (src/managers/spawner.ts, construction.ts)
  sources?: {
    id: Id<Source>;
    /** Cached position so we can path without visibility */
    x: number;
    y: number;
    containerId?: Id<StructureContainer>;
    linkId?: Id<StructureLink>;
    /** Name of the miner creep assigned to this source */
    minerName?: string;
    /** Path distance from source to spawn (tiles). Computed once, used by link priority and hauler sizing. */
    pathDist?: number;
  }[];
  controllerContainerId?: Id<StructureContainer>;
  /** Set to true once containers are built and the room transitions to miner+hauler economy */
  minerEconomy?: boolean;
  // Links (src/managers/links.ts)
  storageLinkId?: Id<StructureLink>;
  controllerLinkId?: Id<StructureLink>;
  // Mineral mining (RCL 6+)
  mineralId?: Id<Mineral>;
  mineralContainerId?: Id<StructureContainer>;
  mineralMinerName?: string;
  // Labs (RCL 6+)
  labIds?: Id<StructureLab>[];
  inputLabIds?: [Id<StructureLab>, Id<StructureLab>];
  activeReaction?: {
    input1: ResourceConstant;
    input2: ResourceConstant;
    output: ResourceConstant;
  };
  labFlushing?: boolean;
  // Pre-computed base layout (src/utils/layoutPlanner.ts)
  layoutPlan?: {
    version: number;
    storagePos: { x: number; y: number };
    terminalPos: { x: number; y: number };
    factoryPos?: { x: number; y: number };
    towerPositions: { x: number; y: number }[];
    labPositions: { x: number; y: number }[];
    extensionPositions: { x: number; y: number }[];
    /** Up to 3 spawn positions (index 0 = primary/live spawn, 1-2 = 2nd/3rd RCL 7-8 spawns). */
    spawnPositions?: { x: number; y: number }[];
  };
  /** Lab reserved for boosting (excluded from reactions). Set by the spawner when a boost is pending; read by ensureBoosted() to locate the boost compound. */
  boostLabId?: Id<StructureLab>;
  /** Compound the reserved boostLabId is loaded with (by the hauler). Set alongside boostLabId by the spawner; consumed by ensureBoosted() via the lab. */
  boostCompound?: ResourceConstant;
  // Factory (RCL 7+)
  factoryId?: Id<StructureFactory>;
  factoryRecipe?: ResourceConstant;
  /**
   * ID of a foreign-owned structure in this room whose store still holds
   * resources we want to capture. Set by cleanupClaimedRoom() when a
   * loot-bearing structure is detected; cleared once the structure is empty.
   * Haulers drain it losslessly via withdraw() (pickupForeignStore in hauler.ts);
   * cleanupClaimedRoom() destroys the empty husk to free the storage slot.
   */
  lootTargetId?: Id<AnyStoreStructure>;
  // Best spawn position suggestion for a not-yet-claimed room
  suggestedSpawnPos?: { x: number; y: number; score: number };
  /**
   * Set when placeRoads() completes a full pass with no unroaded steps found.
   * Cleared when any new construction site is placed (structures changed).
   */
  roadsComplete?: boolean;
  /** Rate-limit tracking for overflow tower placement; stores "x,y" keys already warned about */
  overflowedTowers?: string[];
  /** Rate-limit tracking for placeLabs blocked log; maps "x,y" → last emission tick */
  labStampBlockedLog?: Record<string, number>;
  /**
   * Set when placeRemoteRoads() completes a full pass with all path steps roaded.
   * Re-checked every 50 ticks instead of every 5 when true.
   */
  remoteRoadsComplete?: boolean;
  /**
   * Set when placeColonyBootstrapRoads() confirms all source paths are fully roaded.
   * Re-checked every 50 ticks instead of every 5 when true — avoids 2 extra
   * PathFinder calls per construction tick throughout the RCL2–3 bootstrap phase.
   */
  bootstrapRoadsComplete?: boolean;
  // Remote mining
  remoteRooms?: string[];
  /** Cached round-trip travel ticks (path × 2 × fatigue) keyed by remote room name */
  remoteDistance?: Record<string, number>;
  /** Tick when each remoteDistance entry was last computed (for staleness checks) */
  remoteDistanceUpdated?: Record<string, number>;
  remoteType?: 'remote' | 'reserved' | 'claimed' | 'keeperRoom';
  defensePolicy?: 'flee' | 'defend' | 'abandon';
  // Scout data (populated by scouts visiting unowned rooms)
  scoutedAt?: number;
  /** Set when a scout departs for this room; cleared on arrival. Prevents respawn loops when scout dies at border. */
  scoutAttempted?: number;
  /** Set by markUnreachable when stuck-timer fires; causes a 10× longer rescouting cooldown. Cleared on successful arrival. */
  scoutUnreachable?: boolean;
  scoutedSources?: number;
  /** Source data recorded by scouts, so miners can path without visibility */
  scoutedSourceData?: { id: Id<Source>; x: number; y: number }[];
  scoutedOwner?: string;
  scoutedReservation?: string;
  scoutedHostiles?: number;
  /** True if the last scouted hostile sighting included a player (long rejection window); NPC-only (Invader/Source Keeper) sightings use a short window. */
  scoutedHostileIsPlayer?: boolean;
  scoutedHasController?: boolean;
  /** True when the room contains Source Keeper Lairs — permanently hostile, never remote-mine */
  scoutedHasKeepers?: boolean;
  /** Cached lair positions for keeperKiller patrol; populated on first arrival */
  keeperLairPositions?: { x: number; y: number }[];
  /** Controller position — drives base-layout viability when evaluating a claim */
  scoutedControllerPos?: { x: number; y: number };
  /** Mineral type + position — used to avoid claiming a duplicate mineral and for extractor planning */
  scoutedMineral?: { type: MineralConstant; x: number; y: number };
  /**
   * Abandoned loot recorded at scout time — ruins, tombstones, and large
   * energy drops. Stale within a few thousand ticks (drops decay 1/1000t,
   * tombstones decay in ~5*body.length ticks, ruins in 500t), so consumers
   * should compare `recordedAt` against `Game.time` and bail on anything old.
   */
  scoutedLoot?: {
    recordedAt: number;
    ruins?: { id: Id<Ruin>; x: number; y: number; energy: number; total: number }[];
    tombstones?: { id: Id<Tombstone>; x: number; y: number; energy: number; total: number }[];
    drops?: {
      id: Id<Resource>;
      x: number;
      y: number;
      resourceType: ResourceConstant;
      amount: number;
    }[];
  };
  /**
   * Perimeter defense plan — computed once by `computePerimeter()` in
   * `src/utils/perimeterPlanner.ts`, cached here, and invalidated by
   * `PERIMETER_PLAN_VERSION` bumps or remote-room changes.
   */
  perimeterPlan?: PerimeterPlanData;
}

// ---------------------------------------------------------------------------
// Perimeter planner (src/utils/perimeterPlanner.ts)
// ---------------------------------------------------------------------------

interface PerimeterGateTarget {
  x: number;
  y: number;
  /** Human-readable label: "source(7,14)", "controller", "remote:W43N59", "default-N" */
  reason: string;
}

interface PerimeterPlanData {
  version: number;
  coreRadius: number;
  /** "x,y" encoded exterior tiles that border the interior — every tile that gets a wall or rampart */
  perimeterTiles: string[];
  /** Subset of perimeterTiles — get ramparts only (no wall), kept passable for own creeps */
  gateTiles: string[];
  /** Gate targets this plan was computed from — used to detect remote-room changes */
  gateTargets: PerimeterGateTarget[];
}

// ---------------------------------------------------------------------------
// Combat logging (src/utils/combatLog.ts)
// ---------------------------------------------------------------------------

type CombatEventType =
  | 'threat_appeared' // first tick of a new attack on an owned room
  | 'threat_ended' // all hostiles gone / cleared from an owned room
  | 'safe_mode_activated' // controller.activateSafeMode() succeeded
  | 'safe_mode_unavailable' // would activate but no charges or cooldown blocking
  | 'tower_energy_low'; // a tower dropped below 25 % capacity during active combat

interface CombatEvent {
  tick: number;
  room: string;
  event: CombatEventType;
  /** Aggregate threat score of all hostiles this tick */
  threatScore?: number;
  /** Raw hostile creep count */
  hostileCount?: number;
  /** Unique owner usernames seen */
  owners?: string[];
  /** Number of operational towers this tick */
  towerCount?: number;
  /** Lowest tower energy as a percentage (0–100) — set for tower_energy_low */
  minTowerEnergy?: number;
  /** Safe mode charges remaining after the activation attempt */
  safeModesLeft?: number;
  /** Free-text context that doesn't fit the structured fields */
  details?: string;
}

interface ProfilerSample {
  avg: number;
  last: number;
  max: number;
  samples: number;
}

/**
 * Per-room boost outcome counters (src/utils/boost.ts). Monotonic tallies that
 * survive global resets so chronic boost starvation surfaces in production
 * (read via the `boostStatus()` console command) without needing the verbose
 * `Memory.boostDebug` log-tail. A room where failures dominate `success` means
 * boosting is silently failing — the recurrence the timeout otherwise hides.
 */
interface BoostRoomStat {
  /** ensureBoosted() spent its full travel+wait budget unfilled (BOOST_WAIT_TIMEOUT). */
  failTimeout: number;
  /** No lab could be resolved for the requested compound. */
  failNoLab: number;
  /** Lab empty and no storage/terminal supply exists to refill it. */
  failNoSupply: number;
  /** boostCreep() returned OK. */
  success: number;
  /** Game.time of the most recent failure of any kind. */
  lastFailTick?: number;
}

// ---------------------------------------------------------------------------
// Mission records (src/utils/missions.ts)
// ---------------------------------------------------------------------------

/** Extensible union of all mission types. Extend by adding '| newType'. */
type MissionType = 'remoteMining' | 'colony' | 'defense' | 'transport';

/**
 * Common fields every mission record must carry.
 * Individual mission interfaces extend this with type-specific fields.
 */
interface MissionBase {
  /** Discriminant tag — identifies the mission category. */
  type: MissionType;
  /** Stable unique key within the mission type's sub-map. */
  id: string;
  /** Lifecycle status; concrete mission types narrow this to their own union. */
  status: string;
  /** Game.time when the mission was created. */
  createdAt: number;
  /** Game.time of the last sync call. */
  lastSynced: number;
}

/**
 * A RemoteMiningMission represents the "remote mining <room>" goal as a single
 * typed object in Memory. It owns the hauler IDs and reserver ID for a remote,
 * tracks lifecycle status (active / stalled / retiring), and is the foundation
 * for future empire-level coordination.
 *
 * Miner tracking stays in RoomMemory.sources[n].minerName to avoid two sources
 * of truth. haulerIds and reserverId are derived caches refreshed each tick by
 * syncMission() — the creep's own memory.missionId is the authoritative record.
 */
interface RemoteMiningMission extends MissionBase {
  type: 'remoteMining';
  /** Stable key == remoteRoom name. */
  id: string;
  homeRoom: string;
  remoteRoom: string;
  /** Narrows MissionBase.status to the valid values for this mission type. */
  status: 'active' | 'stalled' | 'retiring';
  /** Names of remoteHauler creeps serving this remote (derived from missionId scan) */
  haulerIds: string[];
  /** Name of the active reserver creep, or null when none is alive */
  reserverId: string | null;
}

/**
 * A ColonyMission represents a target room we intend to claim and grow into a
 * self-sufficient colony. Key = targetRoom name (== id).
 *
 * Lifecycle:
 * - 'claiming'      → claimer is dispatched; awaiting controller.my === true.
 * - 'bootstrapping' → room is claimed but no spawn yet. Home room ships colonyBuilders
 *                     to build the first spawn, then the room transitions to its own
 *                     regular spawn pipeline.
 * - 'active'        → room has its own spawn and is self-sufficient (treated as a
 *                     standard owned room — kept here mostly for status display).
 */
interface ColonyMission extends MissionBase {
  type: 'colony';
  /** Stable key == targetRoom name. */
  id: string;
  /** Parent colony's room name — the room that owns the spawn budget for bootstrap. */
  homeRoom: string;
  /** Narrows MissionBase.status to the valid values for this mission type. */
  status: 'claiming' | 'bootstrapping' | 'active';
  /** Tick when controller.my flipped to true. */
  claimedAt?: number;
  /** Tick when the first spawn finished. */
  activeAt?: number;
  /** Rooms the claimer/colonyBuilder passes through en route (home→target), excluding home and target. */
  transitRooms?: string[];
}

/**
 * A DefenseMission is the registry record for one owned room's active combat
 * engagement. Created when a threat appears, set 'retiring' when it clears so the
 * generic GC reclaims it ~300 ticks later (no defense-specific GC needed). It
 * mirrors the `combatActive` lifecycle in defense.ts — that flag is retained for
 * safe-mode/tower-drain logging; a future cleanup could consolidate the two.
 */
interface DefenseMission extends MissionBase {
  type: 'defense';
  /** Stable key == defended room name. */
  id: string;
  roomName: string;
  /** 'active' while a threat is present; 'retiring' once it clears (GC reclaims). */
  status: 'active' | 'retiring';
  /** Last observed total threat score (snapshot). */
  threatScore: number;
  /** Last observed hostile creep count. */
  hostileCount: number;
  /** Attacker usernames seen this engagement. */
  owners: string[];
  /** Spawn quota the spawner is working toward (stamped by the spawner; {0,0,0} when towers solo it). */
  composition: { melee: number; ranged: number; healer: number };
  /** Derived: defender + rangedDefender creep names currently in the room. */
  defenderIds: string[];
  /** Derived: healer creep names currently in the room. */
  healerIds: string[];
  /** Tick the threat cleared (set when status → retiring). */
  endedAt?: number;
}

/**
 * A TransportMission is a manual, operator-created cross-room energy (or mineral)
 * delivery: couriers shuttle a resource from sourceRoom's primary store to
 * destRoom's OWN storage. Created via the deliverEnergy() console command.
 *
 * Primary use: drain a reclaimed room's previous-owner storage hoard into a
 * mature colony (the source can't bank or locally absorb it, and a terminal
 * doesn't exist until RCL6) — which also empties the husk so the source can build
 * its own storage. Works at any RCL; complements the terminal-based, automatic
 * sendEnergyToColonies (terminal.ts).
 *
 * targetAmount is a CAP: the mission completes on delivered >= target OR when the
 * source is exhausted (delivers whatever was available), so it never hangs.
 * Couriers spawn from destRoom (CreepMemory.homeRoom = dest, targetRoom = source).
 */
interface TransportMission extends MissionBase {
  type: 'transport';
  /** Stable key == `transport:<sourceRoom>-><destRoom>`. */
  id: string;
  sourceRoom: string;
  destRoom: string;
  /** Resource being moved (default RESOURCE_ENERGY). */
  resource: ResourceConstant;
  /** Cap on total delivered; mission completes at this OR when the source empties. */
  targetAmount: number;
  /** Running total deposited into destRoom storage (credited by the courier role). */
  deliveredAmount: number;
  /** 'active' while delivering; 'retiring' once target met or source exhausted (GC reclaims). */
  status: 'active' | 'retiring';
  /** Names of courier creeps serving this mission (derived from missionId scan). */
  courierIds: string[];
}

/**
 * Strictly-typed mission registry.  Adding a future mission type requires one
 * extra field here and a matching sub-map guard in getMissionRegistry().
 */
interface MissionRegistry {
  /** One record per remote room being actively mined. Key = remote room name. */
  remoteMining: Record<string, RemoteMiningMission>;
  /** One record per claim/expansion target. Key = target room name. */
  colony: Record<string, ColonyMission>;
  /** One record per owned room with an active/recent combat engagement. Key = room name. */
  defense: Record<string, DefenseMission>;
  /** One record per active manual cross-room transport. Key = `transport:<src>-><dest>`. */
  transport: Record<string, TransportMission>;
}

interface Memory {
  creeps: { [name: string]: CreepMemory };
  rooms: { [name: string]: RoomMemory };
  /** Mission records keyed by mission type then mission ID. */
  missions?: MissionRegistry;
  /**
   * Ring-buffer of significant combat events (capped at 100 entries).
   * Persists across global resets and room loss so post-mortem analysis is
   * always available. Read via the `combatLog()` console command.
   */
  combatLog?: CombatEvent[];
  // CPU samples by label, keyed by the name passed to profile().
  stats?: { [name: string]: ProfilerSample };
  // Toggles — default off, flip from the in-game console.
  profiling?: boolean;
  visuals?: boolean;
  /** When true, `buyForLabs` skips all market purchases (kill-switch to stop credit bleed). */
  pauseLabBuying?: boolean;
  /**
   * When true, `runVisuals` draws a sorted CPU-stats table (Memory.stats) on
   * the first owned room alongside the normal per-room header. Requires
   * Memory.visuals to also be true. Toggle from the console:
   *   Memory.profileOverlay = true
   */
  profileOverlay?: boolean;
  /**
   * When true, `sellSurplus` logs verbose per-interval diagnostics explaining
   * why it did NOT sell a resource this window (deal too small, no viable buy
   * orders, insufficient terminal energy, etc.). Off by default — in steady
   * state these fire every interval (e.g. batteries trickling in just above the
   * sell floor) and spam the console. Actual sells/failures always log.
   */
  terminalDebug?: boolean;
  /**
   * When true, ensureBoosted() (src/utils/boost.ts) and the hauler boost-lab
   * preempt (src/roles/hauler.ts) log per-tick decisions ([boostDebug] ...) for
   * diagnosing why a creep is/ isn't getting boosted. Temporary diagnostic flag;
   * off by default.
   */
  boostDebug?: boolean;
  /**
   * Per-room boost outcome counters (success / fail-open reasons), keyed by room
   * name. Always-on production signal (unlike boostDebug) so chronic boost
   * failures are visible via `boostStatus()`. See BoostRoomStat.
   */
  boostStats?: Record<string, BoostRoomStat>;
  /**
   * When true, the per-room hauler pool dispatcher (`src/managers/haulerPool.ts`)
   * governs the source-container pickup leg: haulers are pre-assigned to
   * containers based on fill level + proximity so they stop all converging on
   * the globally-fullest container. Off by default (dark-deploy safe); flip
   * from the console to activate, revert to disable with no other changes needed.
   */
  haulerPool?: boolean;
  /**
   * When true, the holistic energy-economy model (`src/utils/economy.ts`)
   * governs all energy-spending decisions: a single colonyEnergy (storage +
   * terminal) budget drives upgrader count (continuous formula, no cliffs),
   * mineral mining eligibility (combined surplus above buffer + reserve
   * margin), wall maintenance targets (moderate-middle floors that yield when
   * lean), factory and energy-export gates. Off by default (dark-deploy safe);
   * the flag-off path preserves exact pre-refactor behaviour. Flip from the
   * console to activate, revert to disable with no rollback needed.
   *   Memory.holisticEconomy = true
   */
  holisticEconomy?: boolean;
  /**
   * When true, shouldThrottleCreep() (src/utils/creepThrottle.ts) probabilistically
   * skips the per-tick role logic of discretionary creeps once the CPU bucket
   * drops into a danger band — a graceful stability mechanism (not added
   * capacity) that prevents the bucket from draining to a hard cutoff. Off by
   * default (dark-deploy safe); flag-off preserves exact pre-change behaviour.
   * Flip from the console to activate, revert to disable with no rollback:
   *   Memory.creepThrottle = true
   */
  creepThrottle?: boolean;
  /**
   * When set, a dismantler creep is spawned from homeRoom to clear obstacle
   * structures (towers) in the target room before claiming. The creep waits
   * until the room is unowned (RCL 0) then dismantles. Clear to cancel:
   *   delete Memory.dismantleTarget
   */
  dismantleTarget?: {
    room: string;
    homeRoom: string;
  };
  /**
   * Compact live-health snapshot refreshed every HEALTH_SNAPSHOT_INTERVAL ticks
   * by writeHealthSnapshot() (src/utils/healthSnapshot.ts). It exists purely so
   * the bot's health can be inspected with a single cheap Memory-path read
   * (`scripts/screeps-query.mjs mem _health`) instead of dumping a console buffer
   * through the MCP server — the filtering happens here, in-game, so only the
   * small object crosses the wire. Read-only telemetry; nothing in the bot
   * consumes it.
   */
  _health?: HealthSnapshot;
}

/** One owned-room entry in the {@link HealthSnapshot}. Field names kept terse to keep the snapshot small. */
interface HealthRoomSnapshot {
  n: string;
  rcl: number;
  /** controller progress %, 1dp */
  cp: number;
  /** safe-mode ticks remaining (0 = inactive) */
  sm: number;
  /** "available/capacity" spawn energy */
  se: string;
  /** own-storage energy, or null if no own storage */
  stE: number | null;
  /** own-storage non-energy minerals */
  stM: Record<string, number>;
  /** own-terminal energy, or null */
  tE: number | null;
  /** own-terminal non-energy minerals */
  tM: Record<string, number>;
  /** per-lab "mineral:amount" ("-:0" when empty) */
  lab: string[];
  /** reserved boost compound, or null */
  bl: string | null;
  /** active reaction output, or null */
  rx: string | null;
}

/** See {@link Memory._health}. Mirrors the HealthCheck skill's rendered shape. */
interface HealthSnapshot {
  t: number;
  sys: {
    b: number;
    lim: number;
    tl: number;
    gcl: number;
    gp: number;
    cr: number;
    ord: number;
    loop: number | null;
    sells: string[];
    buys: string[];
    tr: string[];
  };
  rooms: HealthRoomSnapshot[];
  boost: string;
}

// Screeps provides a global require for loading modules
declare function require(module: string): unknown;

// CJS module object — used to attach console-callable exports
declare const module: { exports: Record<string, unknown> };

// Screeps provides a global console
declare const console: {
  log(...args: unknown[]): void;
};

// Screeps IVM sandbox global — the console evaluates against this object.
// eslint-disable-next-line no-var
declare var global: Record<string, unknown>;
