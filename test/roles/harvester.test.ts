import { harvester } from '../../src/roles/harvester';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';

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

function mockTower(id: string, x: number, y: number, freeCapacity: number): any {
  return {
    id,
    structureType: STRUCTURE_TOWER,
    pos: new RoomPosition(x, y, 'W1N1'),
    store: {
      getFreeCapacity: (resource?: string) => (resource === RESOURCE_ENERGY ? freeCapacity : 0),
    },
  };
}

describe('harvester', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('transitions HARVEST -> DELIVER once full', () => {
    const creep = mockCreep({
      memory: { role: 'harvester', state: 'HARVEST' },
      store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      room: mockRoom({ find: vi.fn(() => []) }),
    });

    harvester.run(creep);

    expect(creep.memory.state).toBe('DELIVER');
  });

  it('transitions DELIVER -> HARVEST once empty', () => {
    const creep = mockCreep({
      memory: { role: 'harvester', state: 'DELIVER' },
      store: { getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
      room: mockRoom({ find: vi.fn(() => []) }),
    });

    harvester.run(creep);

    expect(creep.memory.state).toBe('HARVEST');
  });

  it('delivers to spawn/extension before falling back to towers', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50);
    const room = mockRoom({ find: vi.fn(() => [ext1]) });
    const creep = mockCreep({
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'harvester', state: 'DELIVER' },
      store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      room,
    });

    harvester.run(creep);

    expect(creep.memory.targetId).toBe('ext1');
  });

  it('falls back to a tower when no spawn/extension needs energy', () => {
    const tower = mockTower('tower1', 27, 25, 500);
    const room = mockRoom({
      find: vi.fn((type: number) => (type === FIND_MY_STRUCTURES ? [tower] : [])),
    });
    const creep = mockCreep({
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'harvester', state: 'DELIVER' },
      store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      room,
    });

    harvester.run(creep);

    expect(creep.memory.targetId).toBe('tower1');
  });

  // Regression (2026-09-07): the old DELIVER handler re-picked its target from
  // scratch every tick via a bare `.find()` over spawn/extension/tower. With
  // many creeps concurrently filling extensions, "first match with free
  // capacity" can flip between two different structures tick-to-tick as their
  // fill levels change elsewhere -- each flip re-running PathFinder toward a
  // brand-new destination. A harvester was observed frozen at the same tile
  // for 84+ ticks in W44N57 as a result, despite a fully open one-step path to
  // the nearest spawn. Delegating to deliverToSpawnOrExtension's cached
  // targetId means the target-of-record doesn't change just because some
  // OTHER structure's fill level fluctuated.
  it('keeps a stable target across ticks even as other extensions fluctuate', () => {
    const ext1 = mockExtension('ext1', 27, 25, 50); // closer
    const ext2 = mockExtension('ext2', 40, 40, 50); // far away

    Game.getObjectById = vi.fn((id: string) => (id === 'ext1' ? ext1 : ext2)) as any;

    const room = mockRoom({ find: vi.fn(() => [ext1, ext2]) });
    const creep = mockCreep({
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'harvester', state: 'DELIVER' },
      store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      room,
    });

    harvester.run(creep);
    expect(creep.memory.targetId).toBe('ext1');

    // Simulate ext2 suddenly looking like the "first match" some other way
    // (e.g. a bare `.find()` over a re-ordered array) -- the cached target
    // must not flip just because a fresh scan would have picked differently.
    resetTickCache();
    harvester.run(creep);
    expect(creep.memory.targetId).toBe('ext1');
  });

  it('marks idle when nothing needs energy', () => {
    const room = mockRoom({ find: vi.fn(() => []) });
    const creep = mockCreep({
      pos: new RoomPosition(25, 25, 'W1N1'),
      memory: { role: 'harvester', state: 'DELIVER' },
      store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      room,
    });

    expect(() => harvester.run(creep)).not.toThrow();
  });
});
