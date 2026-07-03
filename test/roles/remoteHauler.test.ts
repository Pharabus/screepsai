import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { remoteHauler } from '../../src/roles/remoteHauler';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/delivery', () => ({
  deliverToSpawnOrExtension: vi.fn(() => false),
  deliverToControllerContainer: vi.fn(() => false),
}));

import { moveTo } from '../../src/utils/movement';

describe('remoteHauler', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  it('picks up from container in remote room', () => {
    const container = {
      id: 'c1' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      hits: 200000,
      hitsMax: 250000,
      store: { getUsedCapacity: () => 500 },
    };

    const remoteRoom = mockRoom({
      name: 'W2N1',
      find: vi.fn(() => []),
    });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });
    creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
      if (opts?.filter?.(container)) return container;
      return undefined;
    });

    remoteHauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalled();
  });

  it('picks up energy from tombstone in remote room', () => {
    const tomb = {
      id: 'tomb1' as Id<Tombstone>,
      store: {
        getUsedCapacity: (r?: string) => (r === undefined ? 100 : r === RESOURCE_ENERGY ? 100 : 0),
      },
    };

    const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_TOMBSTONES) {
        const items = [tomb];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      return null;
    }) as any;

    remoteHauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(tomb, RESOURCE_ENERGY);
  });

  it('skips non-energy minerals from tombstones in remote room', () => {
    const mineralTomb = {
      id: 'tomb2' as Id<Tombstone>,
      store: {
        getUsedCapacity: (r?: string) => (r === undefined ? 5 : r === RESOURCE_ENERGY ? 0 : 5),
      },
    };

    const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
    Memory.rooms['W2N1'] = { sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }] } as any;

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_TOMBSTONES) {
        const items = [mineralTomb];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      return null;
    }) as any;

    remoteHauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('paths toward remote room when not there yet', () => {
    Memory.rooms['W2N1'] = {
      sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
    } as any;

    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: homeRoom,
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
    });

    remoteHauler.run(creep);

    expect(moveTo).toHaveBeenCalled();
  });

  describe('committed pickup', () => {
    it('reuses a committed dropped-energy target instead of re-scanning the room', () => {
      const drop = {
        id: 'drop1' as Id<Resource>,
        resourceType: RESOURCE_ENERGY,
        amount: 200,
      };
      Game.getObjectById = vi.fn(() => drop) as any;

      const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        memory: {
          role: 'remoteHauler',
          state: 'PICKUP',
          targetRoom: 'W2N1',
          homeRoom: 'W1N1',
          targetId: 'drop1',
        },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
        pickup: vi.fn(() => OK),
      });
      creep.pos.findClosestByRange = vi.fn(() => {
        throw new Error('should not re-scan while a committed target is still valid');
      });

      remoteHauler.run(creep);

      expect(creep.pickup).toHaveBeenCalledWith(drop);
      expect(creep.memory.targetId).toBe('drop1');
    });

    it('clears a drained committed container and falls back to a fresh scan', () => {
      const staleContainer = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 0 },
      };
      Game.getObjectById = vi.fn(() => staleContainer) as any;

      const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        memory: {
          role: 'remoteHauler',
          state: 'PICKUP',
          targetRoom: 'W2N1',
          homeRoom: 'W1N1',
          targetId: 'c1',
        },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
        withdraw: vi.fn(() => OK),
      });
      creep.pos.findClosestByRange = vi.fn(() => undefined);

      remoteHauler.run(creep);

      expect(creep.withdraw).not.toHaveBeenCalled();
      expect(creep.memory.targetId).toBeUndefined();
    });

    it('clears a committed target that no longer exists and falls back to a fresh scan', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        memory: {
          role: 'remoteHauler',
          state: 'PICKUP',
          targetRoom: 'W2N1',
          homeRoom: 'W1N1',
          targetId: 'gone1',
        },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
      });
      creep.pos.findClosestByRange = vi.fn(() => undefined);

      remoteHauler.run(creep);

      expect(creep.memory.targetId).toBeUndefined();
    });
  });
});
