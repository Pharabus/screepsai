import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { deliverToSpawnOrExtension, deliverToControllerContainer } from '../../src/utils/delivery';
import { resetTickCache } from '../../src/utils/tickCache';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/trafficManager', () => ({
  PRIORITY_HAULER: 50,
}));

import { moveTo } from '../../src/utils/movement';

function mockExtension(id: string, x: number, y: number, freeCapacity: number): any {
  return {
    id,
    structureType: STRUCTURE_EXTENSION,
    pos: new RoomPosition(x, y, 'W1N1'),
    store: {
      getFreeCapacity: (resource?: string) => (resource === RESOURCE_ENERGY ? freeCapacity : 0),
    },
  };
}

describe('deliverToSpawnOrExtension', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    vi.clearAllMocks();
  });

  it('picks the closest unclaimed extension when another hauler already targets the nearest', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50); // range 2 from creep
    const ext2 = mockExtension('ext2', 29, 25, 50); // range 4 from creep

    const room = mockRoom({
      find: vi.fn(() => [ext1, ext2]),
    });
    const creep = mockCreep({
      name: 'haulerA',
      room,
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'hauler', state: 'DELIVER' },
      store: {
        getUsedCapacity: () => 100,
        getFreeCapacity: () => 0,
      },
    });

    // Another hauler already targeting ext1
    Game.creeps = {
      haulerA: creep,
      haulerB: mockCreep({
        name: 'haulerB',
        memory: { role: 'hauler', state: 'DELIVER', targetId: 'ext1' },
      }),
    };

    deliverToSpawnOrExtension(creep);

    expect(creep.memory.targetId).toBe('ext2');
  });

  it('falls back to closest when all extensions are claimed', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50);
    const ext2 = mockExtension('ext2', 29, 25, 50);

    const room = mockRoom({
      find: vi.fn(() => [ext1, ext2]),
    });
    const creep = mockCreep({
      name: 'haulerA',
      room,
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'hauler', state: 'DELIVER' },
      store: {
        getUsedCapacity: () => 100,
        getFreeCapacity: () => 0,
      },
    });

    Game.creeps = {
      haulerA: creep,
      haulerB: mockCreep({
        name: 'haulerB',
        memory: { role: 'hauler', state: 'DELIVER', targetId: 'ext1' },
      }),
      haulerC: mockCreep({
        name: 'haulerC',
        memory: { role: 'hauler', state: 'DELIVER', targetId: 'ext2' },
      }),
    };

    deliverToSpawnOrExtension(creep);

    expect(creep.memory.targetId).toBe('ext1');
  });

  it('uses cached target when it still has capacity', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50);

    Game.getObjectById = vi.fn(() => ext1);

    const room = mockRoom();
    const creep = mockCreep({
      name: 'haulerA',
      room,
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'hauler', state: 'DELIVER', targetId: 'ext1' },
      store: {
        getUsedCapacity: () => 100,
        getFreeCapacity: () => 0,
      },
    });

    const result = deliverToSpawnOrExtension(creep);

    expect(result).toBe(true);
    expect(creep.memory.targetId).toBe('ext1');
    expect(room.find).not.toHaveBeenCalled();
  });

  it('ignores non-hauler creeps when building claimed set', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50);

    const room = mockRoom({
      find: vi.fn(() => [ext1]),
    });
    const creep = mockCreep({
      name: 'haulerA',
      room,
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'hauler', state: 'DELIVER' },
      store: {
        getUsedCapacity: () => 100,
        getFreeCapacity: () => 0,
      },
    });

    Game.creeps = {
      haulerA: creep,
      builder1: mockCreep({
        name: 'builder1',
        memory: { role: 'builder', state: 'DELIVER', targetId: 'ext1' },
      }),
    };

    deliverToSpawnOrExtension(creep);

    expect(creep.memory.targetId).toBe('ext1');
  });

  it('stays put when multiple adjacent extensions still need energy', () => {
    const adj1 = mockExtension('adj1', 25, 26, 50); // adjacent, range 1
    const adj2 = mockExtension('adj2', 26, 25, 100); // adjacent, range 1
    const farExt = mockExtension('farExt', 40, 40, 50); // cached, far away

    const findInRange = vi.fn(() => [adj1, adj2]);
    const creep = mockCreep({
      name: 'haulerA',
      pos: Object.assign(new RoomPosition(25, 25, 'W1N1'), { findInRange }),
      memory: { role: 'hauler', state: 'DELIVER', targetId: 'farExt' },
      store: {
        getUsedCapacity: () => 200, // more than adj1's free (50) — won't drain into adj1
        getFreeCapacity: () => 600,
      },
    });

    Game.getObjectById = vi.fn(() => farExt) as any;
    Game.creeps = { haulerA: creep };

    const result = deliverToSpawnOrExtension(creep);

    expect(result).toBe(true);
    expect(creep.transfer).toHaveBeenCalledWith(adj1, RESOURCE_ENERGY);
    // Cache must be cleared; otherwise hauler would path to farExt next tick
    expect(creep.memory.targetId).toBeUndefined();
    // No movement: we want it to stay put so next tick fills adj2
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('still paths to cached far target when only one adjacent partial fill is possible', () => {
    const adj1 = mockExtension('adj1', 25, 26, 50);
    const farExt = mockExtension('farExt', 40, 40, 50);

    const findInRange = vi.fn(() => [adj1]); // only ONE adjacent
    const creep = mockCreep({
      name: 'haulerA',
      pos: Object.assign(new RoomPosition(25, 25, 'W1N1'), { findInRange }),
      memory: { role: 'hauler', state: 'DELIVER', targetId: 'farExt' },
      store: {
        getUsedCapacity: () => 200, // more than adj1's free (50) — energy left after fill
        getFreeCapacity: () => 600,
      },
    });

    Game.getObjectById = vi.fn(() => farExt) as any;
    Game.creeps = { haulerA: creep };

    deliverToSpawnOrExtension(creep);

    // Cache preserved; hauler moves on to the next target
    expect(creep.memory.targetId).toBe('farExt');
    expect(moveTo).toHaveBeenCalled();
  });

  it('considers remoteHauler targets as claimed', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50);
    const ext2 = mockExtension('ext2', 29, 25, 50);

    const room = mockRoom({
      find: vi.fn(() => [ext1, ext2]),
    });
    const creep = mockCreep({
      name: 'haulerA',
      room,
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'hauler', state: 'DELIVER' },
      store: {
        getUsedCapacity: () => 100,
        getFreeCapacity: () => 0,
      },
    });

    Game.creeps = {
      haulerA: creep,
      remoteHauler1: mockCreep({
        name: 'remoteHauler1',
        memory: { role: 'remoteHauler', state: 'DELIVER', targetId: 'ext1' },
      }),
    };

    deliverToSpawnOrExtension(creep);

    expect(creep.memory.targetId).toBe('ext2');
  });
});

describe('deliverToControllerContainer', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('returns false when controller container has less than 200 free capacity', () => {
    const cc = {
      id: 'cc1',
      store: {
        getFreeCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 150 : 0),
      },
      pos: new RoomPosition(30, 30, 'W1N1'),
    };

    Game.getObjectById = vi.fn(() => cc) as any;
    (Memory as any).rooms = { W1N1: { controllerContainerId: 'cc1' } };

    const room = mockRoom({ name: 'W1N1' });
    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: { getUsedCapacity: () => 800 },
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    const result = deliverToControllerContainer(creep);
    expect(result).toBe(false);
  });

  it('returns true when controller container has 200+ free capacity', () => {
    const cc = {
      id: 'cc1',
      store: {
        getFreeCapacity: (r?: string) => (r === RESOURCE_ENERGY ? 500 : 0),
      },
      pos: new RoomPosition(30, 30, 'W1N1'),
    };

    Game.getObjectById = vi.fn(() => cc) as any;
    (Memory as any).rooms = { W1N1: { controllerContainerId: 'cc1' } };

    const room = mockRoom({ name: 'W1N1' });
    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: { getUsedCapacity: () => 800 },
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    const result = deliverToControllerContainer(creep);
    expect(result).toBe(true);
  });
});
