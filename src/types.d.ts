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
  | 'hunter';

interface CreepMemory {
  role: CreepRoleName;
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
}

// Per-room persistent memory. Managers extend this as they need cold data
// (planned structure positions, cached source ids, threat tracking, stats).
interface RoomMemory {
  // Defense (src/managers/defense.ts)
  threatLastSeen?: number;
  lastThreatScore?: number;
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
    storagePos: { x: number; y: number };
    terminalPos: { x: number; y: number };
    towerPositions: { x: number; y: number }[];
    labPositions: { x: number; y: number }[];
    extensionPositions: { x: number; y: number }[];
  };
  // Best spawn position suggestion for a not-yet-claimed room
  suggestedSpawnPos?: { x: number; y: number; score: number };
  // Remote mining
  remoteRooms?: string[];
  remoteType?: 'remote' | 'reserved' | 'claimed';
  defensePolicy?: 'flee' | 'defend' | 'abandon';
  // Scout data (populated by scouts visiting unowned rooms)
  scoutedAt?: number;
  /** Set when a scout departs for this room; cleared on arrival. Prevents respawn loops when scout dies at border. */
  scoutAttempted?: number;
  scoutedSources?: number;
  /** Source data recorded by scouts, so miners can path without visibility */
  scoutedSourceData?: { id: Id<Source>; x: number; y: number }[];
  scoutedOwner?: string;
  scoutedReservation?: string;
  scoutedHostiles?: number;
  scoutedHasController?: boolean;
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

interface Memory {
  creeps: { [name: string]: CreepMemory };
  rooms: { [name: string]: RoomMemory };
  /** Multi-room expansion targets keyed by the room being claimed. */
  colonies?: { [targetRoom: string]: ColonyState };
  // CPU samples by label, keyed by the name passed to profile().
  stats?: { [name: string]: ProfilerSample };
  // Toggles — default off, flip from the in-game console.
  profiling?: boolean;
  visuals?: boolean;
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
