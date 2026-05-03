import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { deliverToSpawnOrExtension } from '../../src/utils/delivery';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/trafficManager', () => ({
  PRIORITY_HAULER: 50,
}));

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
  });

  it('picks the closest unclaimed extension when another hauler already targets the nearest', () => {
    const ext1 = mockExtension('ext1', 26, 25, 50); // range 1 from creep
    const ext2 = mockExtension('ext2', 28, 25, 50); // range 3 from creep

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
    const ext1 = mockExtension('ext1', 26, 25, 50);
    const ext2 = mockExtension('ext2', 28, 25, 50);

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
    const ext1 = mockExtension('ext1', 26, 25, 50);

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
    const ext1 = mockExtension('ext1', 26, 25, 50);

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

  it('considers remoteHauler targets as claimed', () => {
    const ext1 = mockExtension('ext1', 26, 25, 50);
    const ext2 = mockExtension('ext2', 28, 25, 50);

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
