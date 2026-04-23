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
(globalThis as any).FIND_STRUCTURES = 107;
(globalThis as any).FIND_MY_STRUCTURES = 108;
(globalThis as any).FIND_MY_CONSTRUCTION_SITES = 111;
(globalThis as any).FIND_MY_SPAWNS = 112;
(globalThis as any).FIND_DROPPED_RESOURCES = 113;

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

// Resource constants
(globalThis as any).RESOURCE_ENERGY = 'energy';

// Return codes
(globalThis as any).OK = 0;
(globalThis as any).ERR_NOT_IN_RANGE = -9;
(globalThis as any).ERR_NOT_ENOUGH_ENERGY = -6;

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
  },
};

(globalThis as any).Memory = {
  creeps: {} as Record<string, any>,
  rooms: {} as Record<string, any>,
};

(globalThis as any).PathFinder = {
  search: () => ({ path: [], ops: 0, cost: 0, incomplete: false }),
  CostMatrix: class {
    _data = new Uint8Array(2500);
    set(x: number, y: number, val: number) {
      this._data[x * 50 + y] = val;
    }
    get(x: number, y: number) {
      return this._data[x * 50 + y];
    }
  },
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
    return this.x === other.x && this.y === other.y && this.roomName === other.roomName;
  }
  isNearTo(other: any) {
    return Math.abs(this.x - other.x) <= 1 && Math.abs(this.y - other.y) <= 1;
  }
  inRangeTo(other: any, range: number) {
    return Math.abs(this.x - other.x) <= range && Math.abs(this.y - other.y) <= range;
  }
  getRangeTo(other: any) {
    return Math.max(Math.abs(this.x - other.x), Math.abs(this.y - other.y));
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
    move: vi.fn(() => 0),
    moveTo: vi.fn(() => 0),
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
    },
  };
  (globalThis as any).Memory = {
    creeps: {},
    rooms: {},
  };
}
