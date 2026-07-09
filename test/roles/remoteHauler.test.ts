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

  // The PICKUP-reselection scan now reads Game.rooms[targetRoom].find(...) /
  // getStructuresByType(room) (cached per room per tick) instead of
  // creep.pos.findClosestByRange — register the mock room under Game.rooms
  // and dispatch its find() by FIND type.
  function makeRemoteRoom(byType: Partial<Record<number, any[]>>): any {
    const room = mockRoom({
      name: 'W2N1',
      find: vi.fn((type: number) => byType[type] ?? []),
    });
    Game.rooms['W2N1'] = room;
    return room;
  }

  it('picks up from container in remote room', () => {
    const container = {
      id: 'c1' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      pos: new RoomPosition(11, 10, 'W2N1'),
      hits: 200000,
      hitsMax: 250000,
      store: { getUsedCapacity: () => 500 },
    };

    const remoteRoom = makeRemoteRoom({ [FIND_STRUCTURES]: [container] });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });

    remoteHauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalled();
  });

  it('picks up energy from tombstone in remote room', () => {
    const tomb = {
      id: 'tomb1' as Id<Tombstone>,
      pos: new RoomPosition(11, 10, 'W2N1'),
      store: {
        getUsedCapacity: (r?: string) => (r === undefined ? 100 : r === RESOURCE_ENERGY ? 100 : 0),
      },
    };

    const remoteRoom = makeRemoteRoom({ [FIND_TOMBSTONES]: [tomb] });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });

    remoteHauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(tomb, RESOURCE_ENERGY);
  });

  it('skips non-energy minerals from tombstones in remote room', () => {
    const mineralTomb = {
      id: 'tomb2' as Id<Tombstone>,
      pos: new RoomPosition(11, 10, 'W2N1'),
      store: {
        getUsedCapacity: (r?: string) => (r === undefined ? 5 : r === RESOURCE_ENERGY ? 0 : 5),
      },
    };

    const remoteRoom = makeRemoteRoom({ [FIND_TOMBSTONES]: [mineralTomb] });
    Memory.rooms['W2N1'] = { sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }] } as any;

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });

    remoteHauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('shares one room scan across multiple haulers assigned to the same remote room in one tick', () => {
    // Regression for the live CPU squeeze: role.remoteHauler was re-running 4
    // full find() scans per hauler per tick during pickup reselection, and
    // remote rooms commonly have 3-4 haulers assigned. getPickupCandidates
    // caches the result per room per tick so N haulers cost 1 scan, not N.
    const container = {
      id: 'c1' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      pos: new RoomPosition(11, 10, 'W2N1'),
      store: { getUsedCapacity: () => 500 },
    };
    const findSpy = vi.fn((type: number) => (type === FIND_STRUCTURES ? [container] : []));
    const remoteRoom = mockRoom({ name: 'W2N1', find: findSpy });
    Game.rooms['W2N1'] = remoteRoom;

    const makeHauler = (x: number, y: number) =>
      mockCreep({
        memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
        room: remoteRoom,
        pos: new RoomPosition(x, y, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
        withdraw: vi.fn(() => OK),
      });
    const haulerA = makeHauler(10, 10);
    const haulerB = makeHauler(20, 20);

    remoteHauler.run(haulerA);
    remoteHauler.run(haulerB);

    expect(haulerA.withdraw).toHaveBeenCalled();
    expect(haulerB.withdraw).toHaveBeenCalled();
    // 4 find types (dropped/structures/ruins/tombstones) called once total,
    // not once per hauler — 8 calls would mean the cache isn't sharing.
    expect(findSpy).toHaveBeenCalledTimes(4);
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

      const remoteRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => {
          throw new Error('should not re-scan while a committed target is still valid');
        }),
      });
      Game.rooms['W2N1'] = remoteRoom;
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

      const remoteRoom = makeRemoteRoom({});
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

      remoteHauler.run(creep);

      expect(creep.withdraw).not.toHaveBeenCalled();
      expect(creep.memory.targetId).toBeUndefined();
    });

    it('clears a committed target that no longer exists and falls back to a fresh scan', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const remoteRoom = makeRemoteRoom({});
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

      remoteHauler.run(creep);

      expect(creep.memory.targetId).toBeUndefined();
    });
  });
});
