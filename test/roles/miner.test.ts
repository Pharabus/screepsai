import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { miner } from '../../src/roles/miner';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/trafficManager', () => ({
  registerStationary: vi.fn(),
  PRIORITY_STATIC: 4,
  PRIORITY_WORKER: 2,
}));

import { moveTo } from '../../src/utils/movement';
import { registerStationary } from '../../src/utils/trafficManager';

describe('miner', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  describe('POSITION state', () => {
    it('assigns an unmined source and stores targetId', () => {
      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as Id<Source>, x: 10, y: 20, containerId: 'c1' as Id<StructureContainer> },
        ],
      } as any;

      const container = {
        id: 'c1' as Id<StructureContainer>,
        pos: new RoomPosition(10, 20, 'W1N1'),
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'c1') return container;
        return undefined;
      }) as any;

      const creep = mockCreep({
        name: 'miner_1',
        memory: { role: 'miner', state: 'POSITION' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      miner.run(creep);

      expect(creep.memory.targetId).toBe('s1');
      expect(Memory.rooms['W1N1'].sources![0]!.minerName).toBe('miner_1');
    });

    it('moves to container when assigned and in same room', () => {
      Memory.rooms['W1N1'] = {
        sources: [
          {
            id: 's1' as Id<Source>,
            x: 10,
            y: 20,
            containerId: 'c1' as Id<StructureContainer>,
            minerName: 'miner_1',
          },
        ],
      } as any;

      const container = {
        id: 'c1' as Id<StructureContainer>,
        pos: new RoomPosition(10, 20, 'W1N1'),
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'c1') return container;
        if (id === 's1') return { id: 's1', pos: new RoomPosition(10, 20, 'W1N1') };
        return undefined;
      }) as any;

      const creep = mockCreep({
        name: 'miner_1',
        memory: { role: 'miner', state: 'POSITION', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      miner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, container, expect.objectContaining({ range: 0 }));
    });

    it('transitions to HARVEST when on container', () => {
      Memory.rooms['W1N1'] = {
        sources: [
          {
            id: 's1' as Id<Source>,
            x: 10,
            y: 20,
            containerId: 'c1' as Id<StructureContainer>,
            minerName: 'miner_1',
          },
        ],
      } as any;

      const container = {
        id: 'c1' as Id<StructureContainer>,
        pos: new RoomPosition(10, 20, 'W1N1'),
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'c1') return container;
        if (id === 's1') return { id: 's1', pos: new RoomPosition(10, 20, 'W1N1') };
        return undefined;
      }) as any;

      const creep = mockCreep({
        name: 'miner_1',
        memory: { role: 'miner', state: 'POSITION', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(10, 20, 'W1N1'),
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('HARVEST');
    });

    it('paths to remote room when target is in different room', () => {
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;
      Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] } as any;

      Game.getObjectById = vi.fn(() => undefined) as any;

      const creep = mockCreep({
        name: 'miner_r1',
        memory: { role: 'miner', state: 'POSITION', targetRoom: 'W2N1', targetId: 'rs1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      miner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 5, y: 15, roomName: 'W2N1' }),
        expect.any(Object),
      );
    });

    it('paths to room center when no source data exists for remote room', () => {
      Memory.rooms['W2N1'] = {} as any;

      Game.getObjectById = vi.fn(() => undefined) as any;

      const creep = mockCreep({
        name: 'miner_r1',
        memory: { role: 'miner', state: 'POSITION', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      miner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 25, y: 25, roomName: 'W2N1' }),
        expect.objectContaining({ range: 20 }),
      );
    });

    it('transitions to HARVEST when near source without container (remote)', () => {
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;
      Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] } as any;

      const source = {
        id: 'rs1' as Id<Source>,
        pos: new RoomPosition(5, 15, 'W2N1'),
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'rs1') return source;
        return undefined;
      }) as any;

      const remoteRoom = mockRoom({ name: 'W2N1', createConstructionSite: vi.fn(() => OK) });

      const creep = mockCreep({
        name: 'miner_r1',
        memory: {
          role: 'miner',
          state: 'POSITION',
          targetRoom: 'W2N1',
          targetId: 'rs1',
        },
        room: remoteRoom,
        pos: new RoomPosition(5, 14, 'W2N1'),
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('HARVEST');
    });
  });

  describe('HARVEST state', () => {
    it('registers as stationary and harvests', () => {
      const source = {
        id: 's1' as Id<Source>,
        pos: {
          findInRange: vi.fn(() => []),
        },
      };

      Game.getObjectById = vi.fn(() => source) as any;
      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      miner.run(creep);

      expect(registerStationary).toHaveBeenCalledWith(creep, 4);
      expect(creep.harvest).toHaveBeenCalledWith(source);
    });

    it('transfers to link when energy available', () => {
      const link = {
        id: 'l1' as Id<StructureLink>,
        store: { getFreeCapacity: () => 400 },
      };
      const source = {
        id: 's1' as Id<Source>,
        pos: { findInRange: vi.fn(() => []) },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 's1') return source;
        if (id === 'l1') return link;
        return undefined;
      }) as any;

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20, linkId: 'l1' as Id<StructureLink> }],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      miner.run(creep);

      expect(creep.transfer).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
    });

    it('transitions to POSITION when source disappears', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;
      Memory.rooms['W1N1'] = { sources: [] } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('POSITION');
      expect(creep.memory.targetId).toBeUndefined();
    });

    it('builds container construction site in remote rooms', () => {
      const site = {
        id: 'site1',
        structureType: STRUCTURE_CONTAINER,
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          findInRange: vi.fn((type: number) => {
            if (type === FIND_MY_CONSTRUCTION_SITES) return [site];
            return [];
          }),
        },
      };

      Game.getObjectById = vi.fn(() => source) as any;
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        store: { getUsedCapacity: () => 30, getFreeCapacity: () => 20 },
      });

      miner.run(creep);

      expect(creep.build).toHaveBeenCalledWith(site);
      expect(creep.harvest).not.toHaveBeenCalled();
    });

    it('repositions when container is built in remote room', () => {
      const container = {
        id: 'rc1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          findInRange: vi.fn((type: number) => {
            if (type === FIND_MY_CONSTRUCTION_SITES) return [];
            if (type === FIND_STRUCTURES) return [container];
            return [];
          }),
        },
      };

      Game.getObjectById = vi.fn(() => source) as any;
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('POSITION');
      expect(Memory.rooms['W2N1'].sources![0]!.containerId).toBe('rc1');
    });
  });
});
