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
  | 'keeperKiller';

interface CreepMemory {
  role: CreepRoleName;
  /** Desired boosts to apply before the creep starts its role; consumed by ensureBoosted() in src/utils/boost.ts. Entries are removed as applied; the field is deleted once all are done (or on fail-open). */
  boosts?: { part: BodyPartConstant; compound: ResourceConstant }[];
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
  /** Cleared at combat start; set once a safe_mode_unavailable event is logged this combat. */
  combatSafeModeLogged?: boolean;
  /** Cleared at combat start; set once a tower_energy_low event is logged this combat. */
  combatTowerDrainLogged?: boolean;
  // Remote room threat — set by any creep that spots a hostile in this room.
  // Used by remote roles to flee and stay home until the threat clears.
  hostileLastSeen?: number;
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

interface ColonyState {
  /** Parent colony's room name — the room that owns the spawn budget for bootstrap. */
  homeRoom: string;
  /**
   * Lifecycle of a colony target:
   * - 'claiming'      → claimer is dispatched; awaiting controller.my === true.
   * - 'bootstrapping' → room is claimed but no spawn yet. Home room ships colonyBuilders
   *                     to build the first spawn, then the room transitions to its own
   *                     regular spawn pipeline.
   * - 'active'        → room has its own spawn and is self-sufficient (treated as a
   *                     standard owned room — kept here mostly for status display).
   */
  status: 'claiming' | 'bootstrapping' | 'active';
  /** Tick when claim() was issued. */
  selectedAt: number;
  /** Tick when controller.my flipped to true. */
  claimedAt?: number;
  /** Tick when the first spawn finished. */
  activeAt?: number;
  /** Rooms the claimer/colonyBuilder passes through en route (home→target), excluding home and target. */
  transitRooms?: string[];
}

// ---------------------------------------------------------------------------
// Mission records (src/utils/missions.ts)
// ---------------------------------------------------------------------------

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
interface RemoteMiningMission {
  homeRoom: string;
  remoteRoom: string;
  status: 'active' | 'stalled' | 'retiring';
  /** Game.time when the mission was created */
  createdAt: number;
  /** Game.time of the last syncMission() call */
  lastSynced: number;
  /** Names of remoteHauler creeps serving this remote (derived from missionId scan) */
  haulerIds: string[];
  /** Name of the active reserver creep, or null when none is alive */
  reserverId: string | null;
}

interface Memory {
  creeps: { [name: string]: CreepMemory };
  rooms: { [name: string]: RoomMemory };
  /** Mission records keyed by mission type then mission ID. */
  missions?: {
    /** One record per remote room being actively mined. Key = remote room name. */
    remoteMining: Record<string, RemoteMiningMission>;
  };
  /** Multi-room expansion targets keyed by the room being claimed. */
  colonies?: { [targetRoom: string]: ColonyState };
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
   * When true, the per-room hauler pool dispatcher (`src/managers/haulerPool.ts`)
   * governs the source-container pickup leg: haulers are pre-assigned to
   * containers based on fill level + proximity so they stop all converging on
   * the globally-fullest container. Off by default (dark-deploy safe); flip
   * from the console to activate, revert to disable with no other changes needed.
   */
  haulerPool?: boolean;
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
