import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import {
  withdrawFromLogistics,
  gatherEnergy,
  harvestFromBestSource,
  STORAGE_ENERGY_FLOOR,
} from '../../src/utils/sources';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

import { moveTo } from '../../src/utils/movement';

describe('sources', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  describe('withdrawFromLogistics', () => {
    it('uses cached target if still valid', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        store: { getUsedCapacity: () => 500 },
      };
      Game.getObjectById = vi.fn(() => container) as any;

      const creep = mockCreep({
        memory: { role: 'builder', targetId: 'c1' },
        withdraw: vi.fn(() => OK),
      });

      const result = withdrawFromLogistics(creep);

      expect(result).toBe(true);
      expect(Game.getObjectById).toHaveBeenCalledWith('c1');
      expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    });

    it('clears cached target when empty and searches for new one', () => {
      const emptyContainer = {
        id: 'c1' as Id<StructureContainer>,
        store: { getUsedCapacity: () => 0 },
      };
      Game.getObjectById = vi.fn(() => emptyContainer) as any;

      const room = mockRoom({
        find: vi.fn(() => []),
        storage: undefined,
      });

      const creep = mockCreep({
        memory: { role: 'builder', targetId: 'c1' },
        room,
      });

      const result = withdrawFromLogistics(creep);

      expect(creep.memory.targetId).toBeUndefined();
      expect(result).toBe(false);
    });

    it('moves to target when not in range', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        store: { getUsedCapacity: () => 500 },
      };
      Game.getObjectById = vi.fn(() => container) as any;

      const creep = mockCreep({
        memory: { role: 'builder', targetId: 'c1' },
        withdraw: vi.fn(() => ERR_NOT_IN_RANGE),
      });

      withdrawFromLogistics(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, container, expect.any(Object));
    });

    it('finds new container sorted by energy amount', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const containerLow = {
        id: 'cLow' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 200 },
      };
      const containerHigh = {
        id: 'cHigh' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 800 },
      };

      const room = mockRoom({
        find: vi.fn((_type: number, opts?: any) => {
          const all = [containerLow, containerHigh];
          return opts?.filter ? all.filter(opts.filter) : all;
        }),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      withdrawFromLogistics(creep);

      expect(creep.memory.targetId).toBe('cHigh');
    });

    it('excludes controller container', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const sourceContainer = {
        id: 'cSrc' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 500 },
      };
      const controllerContainer = {
        id: 'cCtrl' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 900 },
      };

      const room = mockRoom({
        find: vi.fn((_type: number, opts?: any) => {
          const all = [sourceContainer, controllerContainer];
          return opts?.filter ? all.filter(opts.filter) : all;
        }),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = { controllerContainerId: 'cCtrl' } as any;

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      withdrawFromLogistics(creep);

      expect(creep.memory.targetId).toBe('cSrc');
    });

    it('falls back to storage when no containers have energy', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const storage = {
        id: 'stor1' as Id<StructureStorage>,
        store: { getUsedCapacity: () => STORAGE_ENERGY_FLOOR + 1 },
      };

      const room = mockRoom({
        find: vi.fn(() => []),
        storage,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      const result = withdrawFromLogistics(creep);

      expect(result).toBe(true);
      expect(creep.memory.targetId).toBe('stor1');
    });

    it('returns false when no logistics targets available', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        find: vi.fn(() => []),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
      });

      expect(withdrawFromLogistics(creep)).toBe(false);
    });

    it('skips storage when energy is at or below STORAGE_ENERGY_FLOOR', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        find: vi.fn(() => []),
        storage: {
          id: 'stor1' as Id<StructureStorage>,
          structureType: STRUCTURE_STORAGE,
          store: { getUsedCapacity: () => STORAGE_ENERGY_FLOOR },
        },
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
      });

      expect(withdrawFromLogistics(creep)).toBe(false);
    });

    it('withdraws from storage when energy exceeds STORAGE_ENERGY_FLOOR', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const storage = {
        id: 'stor1' as Id<StructureStorage>,
        structureType: STRUCTURE_STORAGE,
        store: { getUsedCapacity: () => STORAGE_ENERGY_FLOOR + 1 },
      };

      const room = mockRoom({
        find: vi.fn(() => []),
        storage,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      expect(withdrawFromLogistics(creep)).toBe(true);
      expect(creep.withdraw).toHaveBeenCalled();
    });

    it('clears cached storage target when storage drops below floor', () => {
      const storage = {
        id: 'stor1' as Id<StructureStorage>,
        structureType: STRUCTURE_STORAGE,
        store: { getUsedCapacity: () => 5000 },
      };
      Game.getObjectById = vi.fn(() => storage) as any;

      const room = mockRoom({
        find: vi.fn(() => []),
        storage,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder', targetId: 'stor1' },
        room,
      });

      const result = withdrawFromLogistics(creep);

      expect(result).toBe(false);
      expect(creep.memory.targetId).toBeUndefined();
    });

    it('prefers storage over containers when both have energy', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const container = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 500 },
      };
      const storage = {
        id: 'stor1' as Id<StructureStorage>,
        structureType: STRUCTURE_STORAGE,
        store: { getUsedCapacity: () => STORAGE_ENERGY_FLOOR + 1 },
      };

      const room = mockRoom({
        find: vi.fn((_type: number, opts?: any) => {
          const all = [container];
          return opts?.filter ? all.filter(opts.filter) : all;
        }),
        storage,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      withdrawFromLogistics(creep);

      expect(creep.memory.targetId).toBe('stor1');
    });

    it('skips linked source containers', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const linkedContainer = {
        id: 'cLinked' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 500 },
      };
      const unlinkedContainer = {
        id: 'cUnlinked' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 300 },
      };

      const room = mockRoom({
        find: vi.fn((_type: number, opts?: any) => {
          const all = [linkedContainer, unlinkedContainer];
          return opts?.filter ? all.filter(opts.filter) : all;
        }),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as any, x: 10, y: 10, containerId: 'cLinked', linkId: 'link1' },
          { id: 's2' as any, x: 20, y: 20, containerId: 'cUnlinked' },
        ],
      } as any;

      const creep = mockCreep({
        memory: { role: 'builder' },
        room,
        withdraw: vi.fn(() => OK),
      });

      withdrawFromLogistics(creep);

      expect(creep.memory.targetId).toBe('cUnlinked');
    });

    it('still withdraws from cached container regardless of floor', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
        store: { getUsedCapacity: () => 500 },
      };
      Game.getObjectById = vi.fn(() => container) as any;

      const room = mockRoom({
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        memory: { role: 'builder', targetId: 'c1' },
        room,
        withdraw: vi.fn(() => OK),
      });

      expect(withdrawFromLogistics(creep)).toBe(true);
      expect(creep.withdraw).toHaveBeenCalled();
    });
  });

  describe('harvestFromBestSource', () => {
    it('harvests from the source with fewest nearby creeps', () => {
      const srcA = {
        id: 'sA' as Id<Source>,
        pos: new RoomPosition(10, 10, 'W1N1'),
      };
      const srcB = {
        id: 'sB' as Id<Source>,
        pos: new RoomPosition(40, 40, 'W1N1'),
      };

      const otherCreep = {
        name: 'other',
        room: { name: 'W1N1' },
        pos: new RoomPosition(10, 10, 'W1N1'),
        store: { getFreeCapacity: () => 50 },
      };

      Game.creeps = { other: otherCreep } as any;

      const room = mockRoom({
        find: vi.fn(() => [srcA, srcB]),
      });

      const creep = mockCreep({
        name: 'test_creep',
        room,
        pos: new RoomPosition(25, 25, 'W1N1'),
        harvest: vi.fn(() => ERR_NOT_IN_RANGE),
      });

      harvestFromBestSource(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, srcB, expect.any(Object));
    });

    it('harvests directly when in range', () => {
      const source = {
        id: 'sA' as Id<Source>,
        pos: new RoomPosition(25, 25, 'W1N1'),
      };

      Game.creeps = {};

      const room = mockRoom({
        find: vi.fn(() => [source]),
      });

      const creep = mockCreep({
        name: 'test_creep',
        room,
        pos: new RoomPosition(25, 25, 'W1N1'),
        harvest: vi.fn(() => OK),
      });

      harvestFromBestSource(creep);

      expect(creep.harvest).toHaveBeenCalledWith(source);
      expect(moveTo).not.toHaveBeenCalled();
    });

    it('does nothing when no active sources', () => {
      Game.creeps = {};

      const room = mockRoom({
        find: vi.fn(() => []),
      });

      const creep = mockCreep({ room });

      harvestFromBestSource(creep);

      expect(moveTo).not.toHaveBeenCalled();
      expect(creep.harvest).not.toHaveBeenCalled();
    });
  });

  describe('gatherEnergy', () => {
    it('returns true immediately when store is full', () => {
      const creep = mockCreep({
        store: {
          getFreeCapacity: () => 0,
          getUsedCapacity: () => 50,
        },
      });

      expect(gatherEnergy(creep)).toBe(true);
    });

    it('returns false when still gathering', () => {
      Game.creeps = {};
      const room = mockRoom({
        find: vi.fn(() => []),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        room,
        store: {
          getFreeCapacity: () => 50,
          getUsedCapacity: () => 0,
        },
      });

      expect(gatherEnergy(creep)).toBe(false);
    });

    it('uses withdrawFromLogistics in miner economy', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const storage = {
        id: 'stor1' as Id<StructureStorage>,
        store: { getUsedCapacity: () => STORAGE_ENERGY_FLOOR + 1 },
      };

      const room = mockRoom({
        find: vi.fn(() => []),
        storage,
      });

      Memory.rooms['W1N1'] = { minerEconomy: true } as any;

      const creep = mockCreep({
        room,
        memory: { role: 'builder' },
        store: { getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
        withdraw: vi.fn(() => OK),
      });

      gatherEnergy(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    });

    it('falls back to harvesting when logistics empty in miner economy', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;
      Game.creeps = {};

      const source = {
        id: 'sA' as Id<Source>,
        pos: new RoomPosition(10, 10, 'W1N1'),
      };

      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) return [];
          if (type === FIND_SOURCES_ACTIVE) return [source];
          return [];
        }),
        storage: undefined,
      });

      Memory.rooms['W1N1'] = { minerEconomy: true } as any;

      const creep = mockCreep({
        name: 'test_creep',
        room,
        memory: { role: 'builder' },
        store: { getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
        harvest: vi.fn(() => ERR_NOT_IN_RANGE),
      });

      gatherEnergy(creep);

      expect(moveTo).toHaveBeenCalled();
    });

    it('harvests directly in bootstrap economy', () => {
      Game.creeps = {};

      const source = {
        id: 'sA' as Id<Source>,
        pos: new RoomPosition(10, 10, 'W1N1'),
      };

      const room = mockRoom({
        find: vi.fn(() => [source]),
      });

      Memory.rooms['W1N1'] = {};

      const creep = mockCreep({
        name: 'test_creep',
        room,
        store: { getFreeCapacity: () => 50, getUsedCapacity: () => 0 },
        harvest: vi.fn(() => ERR_NOT_IN_RANGE),
      });

      gatherEnergy(creep);

      expect(moveTo).toHaveBeenCalled();
    });
  });
});
