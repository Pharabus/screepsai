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
  | 'remoteBuilder';

interface CreepMemory {
  role: CreepRoleName;
  /** ID of the assigned target (source, container, controller, mineral, etc.) */
  targetId?: Id<
    | Source
    | Mineral
    | Resource
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
  scoutedSources?: number;
  /** Source data recorded by scouts, so miners can path without visibility */
  scoutedSourceData?: { id: Id<Source>; x: number; y: number }[];
  scoutedOwner?: string;
  scoutedReservation?: string;
  scoutedHostiles?: number;
  scoutedHasController?: boolean;
}

interface ProfilerSample {
  avg: number;
  last: number;
  max: number;
  samples: number;
}

interface Memory {
  creeps: { [name: string]: CreepMemory };
  rooms: { [name: string]: RoomMemory };
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
