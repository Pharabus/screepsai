import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { repairer } from '../../src/roles/repairer';

vi.mock('../../src/utils/movement', () => ({ moveTo: vi.fn() }));
vi.mock('../../src/utils/trafficManager', () => ({ PRIORITY_WORKER: 30 }));
vi.mock('../../src/utils/sources', () => ({
  gatherEnergy: vi.fn(() => true), // simulate full store by default
}));
vi.mock('../../src/utils/thresholds', () => ({
  REPAIR_THRESHOLD: 0.75,
}));

import { gatherEnergy } from '../../src/utils/sources';

function makeStructure(type: string, hits: number, hitsMax: number): any {
  return {
    id: `struct_${type}_${Math.random()}`,
    structureType: type,
    hits,
    hitsMax,
    pos: new RoomPosition(10, 10, 'W1N1'),
  };
}

/**
 * Create a room.find mock that applies the filter option correctly,
 * matching how the real Screeps room.find works.
 */
function makeFindWithFilter(
  structures: any[],
): (type: number, opts?: { filter?: (s: any) => boolean }) => any[] {
  return vi.fn((type: number, opts?: { filter?: (s: any) => boolean }) => {
    if (opts?.filter) return structures.filter(opts.filter);
    return structures;
  });
}

describe('repairer role', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    vi.clearAllMocks();
  });

  it('repairs a damaged structure below REPAIR_THRESHOLD', () => {
    const container = makeStructure(STRUCTURE_CONTAINER, 500, 1000); // 50% < 75%
    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([container]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.repair).toHaveBeenCalledWith(container);
  });

  it('does NOT repair ramparts (fix #10 — towers handle ramparts)', () => {
    // Rampart at 1 HP — previously the repairer would target this
    const rampart = makeStructure(STRUCTURE_RAMPART, 1, 300_000);
    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([rampart]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.repair).not.toHaveBeenCalledWith(rampart);
  });

  it('does NOT repair walls', () => {
    const wall = makeStructure(STRUCTURE_WALL, 1, 300_000_000);
    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([wall]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.repair).not.toHaveBeenCalledWith(wall);
  });

  it('falls back to upgrading controller when no repairable structures exist', () => {
    const controller = {
      my: true,
      level: 4,
      pos: new RoomPosition(30, 30, 'W1N1'),
    };
    const room = mockRoom({ name: 'W1N1' });
    room.controller = controller;
    // Only ramparts and walls present — both excluded from repair filter
    const rampart = makeStructure(STRUCTURE_RAMPART, 1, 300_000);
    // The filter excludes ramparts/walls so the filtered result is []
    room.find = makeFindWithFilter([rampart]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.repair).not.toHaveBeenCalled();
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  it('transitions from REPAIR to GATHER when energy is empty', () => {
    // When energy is zero, REPAIR → GATHER transition occurs. The state machine
    // chains and runs GATHER immediately; gatherEnergy returns false (gathering),
    // so the final state is GATHER.
    vi.mocked(gatherEnergy).mockReturnValueOnce(false);

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (_r?: string) => 0,
        getFreeCapacity: () => 100,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.memory.state).toBe('GATHER');
  });

  it('transitions from GATHER to REPAIR when energy is full', () => {
    // gatherEnergy returns true → GATHER returns 'REPAIR'. The state machine
    // chains and runs REPAIR immediately; the store returns 0 energy (gatherEnergy
    // mock ran the first call) so REPAIR checks again → the store mock needs to
    // reflect a full store during the REPAIR run.
    // Simplest approach: mock gatherEnergy to return true once (GATHER→REPAIR),
    // and give the creep a non-zero store so REPAIR doesn't immediately go back.
    vi.mocked(gatherEnergy).mockReturnValueOnce(true);

    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'GATHER' },
      store: {
        // Return 100 so REPAIR state doesn't immediately bounce back to GATHER
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.memory.state).toBe('REPAIR');
  });

  it('repairs structures in between (not fully healthy, not wall/rampart)', () => {
    // Road at 25% hits — should be repaired (< 75% threshold)
    const road = makeStructure(STRUCTURE_ROAD, 1250, 5000);
    const room = mockRoom({ name: 'W1N1' });
    room.controller = { my: true, level: 4, pos: new RoomPosition(30, 30, 'W1N1') };
    room.find = makeFindWithFilter([road]) as any;

    const creep = mockCreep({
      room,
      memory: { role: 'repairer', state: 'REPAIR' },
      store: {
        getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 100 : 0),
        getFreeCapacity: () => 0,
      },
    });
    Memory.rooms['W1N1'] = {};

    repairer.run(creep);

    expect(creep.repair).toHaveBeenCalledWith(road);
  });
});
