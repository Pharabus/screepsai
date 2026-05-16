// Body part constants (string values matching Screeps runtime)
(globalThis as any).MOVE = 'move';
(globalThis as any).WORK = 'work';
(globalThis as any).CARRY = 'carry';
(globalThis as any).ATTACK = 'attack';
(globalThis as any).RANGED_ATTACK = 'ranged_attack';
(globalThis as any).HEAL = 'heal';
(globalThis as any).CLAIM = 'claim';
(globalThis as any).TOUGH = 'tough';

// Find constants (numeric values matching Screeps runtime)
(globalThis as any).FIND_SOURCES = 101;
(globalThis as any).FIND_SOURCES_ACTIVE = 104;
(globalThis as any).FIND_MY_CREEPS = 106;
(globalThis as any).FIND_HOSTILE_CREEPS = 114;
(globalThis as any).FIND_HOSTILE_STRUCTURES = 109;
(globalThis as any).FIND_STRUCTURES = 107;
(globalThis as any).FIND_MY_STRUCTURES = 108;
(globalThis as any).FIND_CONSTRUCTION_SITES = 130;
(globalThis as any).FIND_MY_CONSTRUCTION_SITES = 111;
(globalThis as any).FIND_MY_SPAWNS = 112;
(globalThis as any).FIND_DROPPED_RESOURCES = 113;
(globalThis as any).FIND_MINERALS = 110;
(globalThis as any).FIND_RUINS = 123;
(globalThis as any).FIND_TOMBSTONES = 118;

// Look constants
(globalThis as any).LOOK_STRUCTURES = 'structure';
(globalThis as any).LOOK_CONSTRUCTION_SITES = 'constructionSite';

// Structure type constants
(globalThis as any).STRUCTURE_SPAWN = 'spawn';
(globalThis as any).STRUCTURE_EXTENSION = 'extension';
(globalThis as any).STRUCTURE_TOWER = 'tower';
(globalThis as any).STRUCTURE_WALL = 'constructedWall';
(globalThis as any).STRUCTURE_RAMPART = 'rampart';
(globalThis as any).STRUCTURE_CONTAINER = 'container';
(globalThis as any).STRUCTURE_LINK = 'link';
(globalThis as any).STRUCTURE_ROAD = 'road';
(globalThis as any).STRUCTURE_EXTRACTOR = 'extractor';
(globalThis as any).STRUCTURE_STORAGE = 'storage';
(globalThis as any).STRUCTURE_TERMINAL = 'terminal';
(globalThis as any).STRUCTURE_LAB = 'lab';

// Resource constants
(globalThis as any).RESOURCE_ENERGY = 'energy';

// Lab constants
(globalThis as any).LAB_MINERAL_CAPACITY = 3000;
(globalThis as any).LAB_ENERGY_CAPACITY = 2000;
(globalThis as any).LAB_REACTION_AMOUNT = 5;
(globalThis as any).LAB_COOLDOWN = 10;

// Reactions (tier 1-3 subset for testing)
(globalThis as any).REACTIONS = {
  // Tier 1: base mineral pairs
  H: {
    O: 'OH',
    L: 'LH',
    K: 'KH',
    U: 'UH',
    Z: 'ZH',
    G: 'GH',
    // Tier 3: tier2 + H → tier3 boost
    ZHO2: 'XZHO2',
    LHO2: 'XLHO2',
    GHO2: 'XGHO2',
    KHO2: 'XKHO2',
    UHO2: 'XUHO2',
  },
  O: {
    H: 'OH',
    L: 'LO',
    K: 'KO',
    U: 'UO',
    Z: 'ZO',
    G: 'GO',
    // Tier 2: compound + O → tier2
    ZH: 'ZHO2',
    LH: 'LHO2',
    GH: 'GHO2',
    KH: 'KHO2',
    UH: 'UHO2',
    // Tier 3: tier2 + O (some)
    GH2O: 'GHO2',
  },
  Z: { K: 'ZK', H: 'ZH', O: 'ZO' },
  L: { H: 'LH', O: 'LO', U: 'UL' },
  K: { H: 'KH', O: 'KO', Z: 'ZK' },
  U: { H: 'UH', O: 'UO', L: 'UL' },
  G: { H: 'GH', O: 'GO' },
  // Tier 2 compounds as keys (react with H or O to produce tier3)
  ZH: { O: 'ZHO2' },
  LH: { O: 'LHO2' },
  GH: { O: 'GHO2' },
  KH: { O: 'KHO2' },
  UH: { O: 'UHO2' },
  OH: { ZH: 'ZH2O', LH: 'LH2O', GH: 'GH2O', KH: 'KH2O', UH: 'UH2O' },
  // Tier 2 hydrides (compound + OH)
  ZH2O: { O: 'ZHO2' },
  LH2O: { O: 'LHO2' },
  GH2O: { O: 'GHO2' },
  KH2O: { O: 'KHO2' },
  UH2O: { O: 'UHO2' },
};

// Return codes
(globalThis as any).OK = 0;
(globalThis as any).ERR_NOT_IN_RANGE = -9;
(globalThis as any).ERR_NOT_ENOUGH_ENERGY = -6;
(globalThis as any).ERR_NO_PATH = -2;
(globalThis as any).ERR_INVALID_ARGS = -10;
(globalThis as any).ERR_GCL_NOT_ENOUGH = -15;

// Market order types
(globalThis as any).ORDER_BUY = 'buy';
(globalThis as any).ORDER_SELL = 'sell';

// Terrain
(globalThis as any).TERRAIN_MASK_WALL = 1;

// Game and Memory globals
(globalThis as any).Game = {
  time: 1,
  creeps: {} as Record<string, any>,
  rooms: {} as Record<string, any>,
  spawns: {} as Record<string, any>,
  getObjectById: () => undefined,
  map: {
    getRoomTerrain: () => ({ get: () => 0 }),
    describeExits: () => ({}),
    findExit: () => -2,
    findRoute: () => [],
  },
};

(globalThis as any).Memory = {
  creeps: {} as Record<string, any>,
  rooms: {} as Record<string, any>,
};

class MockCostMatrix {
  _data = new Uint8Array(2500);
  set(x: number, y: number, val: number) {
    this._data[x * 50 + y] = val;
  }
  get(x: number, y: number) {
    return this._data[x * 50 + y];
  }
  clone() {
    const copy = new MockCostMatrix();
    copy._data = new Uint8Array(this._data);
    return copy;
  }
}

(globalThis as any).PathFinder = {
  search: () => ({ path: [], ops: 0, cost: 0, incomplete: false }),
  CostMatrix: MockCostMatrix,
};

(globalThis as any).RoomPosition = class {
  x: number;
  y: number;
  roomName: string;
  constructor(x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }
  isEqualTo(other: any) {
    const pos = other.pos ?? other;
    return (
      this.x === pos.x && this.y === pos.y && this.roomName === (pos.roomName ?? other.roomName)
    );
  }
  isNearTo(other: any) {
    const pos = other.pos ?? other;
    return Math.abs(this.x - pos.x) <= 1 && Math.abs(this.y - pos.y) <= 1;
  }
  inRangeTo(other: any, range: number) {
    const pos = other.pos ?? other;
    return Math.abs(this.x - pos.x) <= range && Math.abs(this.y - pos.y) <= range;
  }
  getRangeTo(other: any) {
    const pos = other.pos ?? other;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }
  getDirectionTo(_other: any) {
    return 1 as any;
  }
  findClosestByRange(_type: any, _opts?: any) {
    return undefined;
  }
  findInRange(_type: any, _range: number, _opts?: any) {
    return [];
  }
  lookFor(_type: any) {
    return [];
  }
};

(globalThis as any).RoomVisual = class {
  poly() {
    return this;
  }
  circle() {
    return this;
  }
};

// Factory helpers

export function mockCreep(overrides: Record<string, any> = {}): any {
  return {
    name: overrides.name ?? 'test_creep',
    body: overrides.body ?? [],
    hits: overrides.hits ?? 100,
    hitsMax: overrides.hitsMax ?? 100,
    pos: overrides.pos ?? new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
    room: overrides.room ?? mockRoom(),
    memory: overrides.memory ?? { role: 'harvester' },
    store: overrides.store ?? {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 50,
    },
    harvest: vi.fn(() => 0),
    build: vi.fn(() => 0),
    repair: vi.fn(() => 0),
    transfer: vi.fn(() => 0),
    withdraw: vi.fn(() => 0),
    pickup: vi.fn(() => 0),
    upgradeController: vi.fn(() => 0),
    attack: vi.fn(() => 0),
    dismantle: vi.fn(() => 0),
    heal: vi.fn(() => 0),
    move: vi.fn(() => 0),
    moveTo: vi.fn(() => 0),
    getActiveBodyparts: vi.fn((type: string) => {
      const body = overrides.body ?? [];
      return body.filter((p: any) => (p.type ?? p) === type && (p.hits ?? 100) > 0).length;
    }),
    ...overrides,
  };
}

export function mockRoom(overrides: Record<string, any> = {}): any {
  return {
    name: overrides.name ?? 'W1N1',
    controller: overrides.controller ?? { my: true, level: 4 },
    energyAvailable: overrides.energyAvailable ?? 300,
    energyCapacityAvailable: overrides.energyCapacityAvailable ?? 300,
    storage: overrides.storage ?? undefined,
    find: overrides.find ?? vi.fn(() => []),
    ...overrides,
  };
}

export function resetGameGlobals(): void {
  (globalThis as any).Game = {
    time: 1,
    creeps: {},
    rooms: {},
    spawns: {},
    getObjectById: () => undefined,
    map: {
      getRoomTerrain: () => ({ get: () => 0 }),
      describeExits: () => ({}),
      findExit: () => -2,
      findRoute: () => [],
    },
  };
  (globalThis as any).Memory = {
    creeps: {},
    rooms: {},
  };
  (globalThis as any).RawMemory = {
    segments: {} as Record<number, string>,
    setActiveSegments: vi.fn(),
  };
}
