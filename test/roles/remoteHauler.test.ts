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

  describe('remote container repair', () => {
    it('repairs damaged container before picking up energy', () => {
      const damaged = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        hits: 100000,
        hitsMax: 250000,
      };

      const remoteRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => []),
      });

      const creep = mockCreep({
        memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 100 },
        repair: vi.fn(() => OK),
      });
      creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES && opts?.filter(damaged)) return damaged;
        return undefined;
      });

      remoteHauler.run(creep);

      expect(creep.repair).toHaveBeenCalledWith(damaged);
    });

    it('moves to damaged container when not in range', () => {
      const damaged = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        hits: 100000,
        hitsMax: 250000,
      };

      const remoteRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => []),
      });

      const creep = mockCreep({
        memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 100 },
        repair: vi.fn(() => ERR_NOT_IN_RANGE),
      });
      creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES && opts?.filter(damaged)) return damaged;
        return undefined;
      });

      remoteHauler.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        damaged,
        expect.objectContaining({ visualizePathStyle: { stroke: '#ff3333' } }),
      );
    });

    it('skips repair when container is above 50% HP', () => {
      const healthy = {
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
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 100 },
        withdraw: vi.fn(() => OK),
      });
      creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
        if (opts?.filter?.(healthy)) return healthy;
        return undefined;
      });

      remoteHauler.run(creep);

      expect(creep.repair).not.toHaveBeenCalled();
      // Should have withdrawn from the container instead (it passes the energy filter)
      expect(creep.withdraw).toHaveBeenCalled();
    });

    it('skips repair when hauler has no energy', () => {
      const damaged = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        hits: 50000,
        hitsMax: 250000,
      };

      const remoteRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => []),
      });

      const creep = mockCreep({
        memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
        room: remoteRoom,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: { getFreeCapacity: () => 400, getUsedCapacity: () => 0 },
      });
      creep.pos.findClosestByRange = vi.fn(() => damaged);

      remoteHauler.run(creep);

      expect(creep.repair).not.toHaveBeenCalled();
    });

    it('does not repair containers in home room during PICKUP travel', () => {
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
        store: { getFreeCapacity: () => 200, getUsedCapacity: () => 100 },
      });
      creep.pos.findClosestByRange = vi.fn(() => undefined);

      remoteHauler.run(creep);

      expect(creep.repair).not.toHaveBeenCalled();
      expect(moveTo).toHaveBeenCalled();
    });
  });
});
