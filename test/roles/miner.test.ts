import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { miner } from '../../src/roles/miner';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
  isInRoomInterior: vi.fn(() => true),
}));

vi.mock('../../src/utils/trafficManager', () => ({
  registerStationary: vi.fn(),
  PRIORITY_STATIC: 4,
  PRIORITY_WORKER: 2,
}));

import { moveTo, isInRoomInterior } from '../../src/utils/movement';
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

    it('Fix B: reclaims own assigned source when targetId is missing but minerName matches', () => {
      // The plan's minerName still points at this creep even though targetId was wiped.
      // POSITION should rediscover the source via findOwnedSource and NOT fall through
      // to a different unassigned source.
      Memory.rooms['W2N1'] = {
        sources: [
          {
            id: 'rs1' as Id<Source>,
            x: 5,
            y: 15,
            minerName: 'miner_r1', // still assigned to this creep
          },
          {
            id: 'rs2' as Id<Source>,
            x: 10,
            y: 20,
            // no minerName → findUnminedSource would pick this one first
          },
        ],
      } as any;
      Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] } as any;

      Game.getObjectById = vi.fn(() => undefined) as any;

      const creep = mockCreep({
        name: 'miner_r1',
        memory: {
          role: 'miner',
          state: 'POSITION',
          targetRoom: 'W2N1',
          // targetId intentionally absent — simulates the wipe from Fix A
        },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(5, 15, 'W2N1'),
      });

      miner.run(creep);

      // Must reclaim rs1 (its own source), not rs2 (the free one)
      expect(creep.memory.targetId).toBe('rs1');
    });

    it('Fix C: moves toward interior when inside target room on a border tile with no source', () => {
      // No sources resolved yet — room memory empty
      Memory.rooms['W2N1'] = {} as any;
      Game.getObjectById = vi.fn(() => undefined) as any;

      // Simulate border tile: isInRoomInterior returns false
      vi.mocked(isInRoomInterior).mockReturnValueOnce(false);

      const creep = mockCreep({
        name: 'miner_r1',
        memory: { role: 'miner', state: 'POSITION', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }), // already inside target room
        pos: new RoomPosition(0, 25, 'W2N1'), // border tile
      });

      miner.run(creep);

      // Must issue a moveTo toward room interior (25,25) so the engine can't evict
      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 25, y: 25, roomName: 'W2N1' }),
        expect.objectContaining({ range: 20 }),
      );
    });

    it('Fix C: does NOT move to interior when already interior (no ping-pong)', () => {
      // isInRoomInterior returns true (default mock) — no extra moveTo should fire
      Memory.rooms['W2N1'] = {} as any;
      Game.getObjectById = vi.fn(() => undefined) as any;

      // Default mock returns true → already interior
      vi.mocked(isInRoomInterior).mockReturnValueOnce(true);

      const creep = mockCreep({
        name: 'miner_r1',
        memory: { role: 'miner', state: 'POSITION', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      miner.run(creep);

      // moveTo must NOT have been called — no unnecessary movement
      expect(moveTo).not.toHaveBeenCalled();
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
          x: 25,
          y: 25,
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
        pos: { x: 25, y: 25, findInRange: vi.fn(() => []) },
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

    it('clears targetId and transitions to POSITION when source disappears and room is visible', () => {
      // Fix A: room IS visible, object truly gone → clear targetId (original behaviour preserved)
      Game.getObjectById = vi.fn(() => undefined) as any;
      Game.rooms['W1N1'] = mockRoom({ name: 'W1N1' });
      Memory.rooms['W1N1'] = { sources: [] } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('POSITION');
      expect(creep.memory.targetId).toBeUndefined();
    });

    it('Fix A: retains targetId and transitions to POSITION when target room is not visible', () => {
      // getObjectById returns null but the remote room is dark — not a real loss.
      Game.getObjectById = vi.fn(() => undefined) as any;
      // W2N1 NOT in Game.rooms — room is dark.
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
      });

      miner.run(creep);

      // targetId must NOT be wiped — room was invisible
      expect(creep.memory.targetId).toBe('rs1');
      // Still transitions to POSITION so the creep travels back
      expect(creep.memory.state).toBe('POSITION');
    });

    it('builds container construction site in remote rooms', () => {
      const site = {
        id: 'site1',
        structureType: STRUCTURE_CONTAINER,
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          x: 25,
          y: 25,
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

    it('repairs damaged container in remote room instead of harvesting', () => {
      const container = {
        id: 'rc1' as Id<StructureContainer>,
        hits: 245000,
        hitsMax: 250000,
        pos: { x: 25, y: 25, roomName: 'W1N1' },
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          x: 25,
          y: 26,
          findInRange: vi.fn(() => []),
        },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'rs1') return source;
        if (id === 'rc1') return container;
        return undefined;
      }) as any;

      Memory.rooms['W2N1'] = {
        sources: [
          {
            id: 'rs1' as Id<Source>,
            x: 5,
            y: 15,
            containerId: 'rc1' as Id<StructureContainer>,
          },
        ],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      miner.run(creep);

      expect(creep.repair).toHaveBeenCalledWith(container);
      expect(creep.harvest).not.toHaveBeenCalled();
    });

    it('harvests normally when remote container is at full health', () => {
      const container = {
        id: 'rc1' as Id<StructureContainer>,
        hits: 250000,
        hitsMax: 250000,
        pos: { x: 25, y: 25, roomName: 'W1N1' },
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          x: 25,
          y: 26,
          findInRange: vi.fn(() => []),
        },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'rs1') return source;
        if (id === 'rc1') return container;
        return undefined;
      }) as any;

      Memory.rooms['W2N1'] = {
        sources: [
          {
            id: 'rs1' as Id<Source>,
            x: 5,
            y: 15,
            containerId: 'rc1' as Id<StructureContainer>,
          },
        ],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      miner.run(creep);

      expect(creep.repair).not.toHaveBeenCalled();
      expect(creep.harvest).toHaveBeenCalledWith(source);
    });

    it('does not repair container for local miners', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        hits: 245000,
        hitsMax: 250000,
        pos: { x: 25, y: 25, roomName: 'W1N1' },
      };
      const source = {
        id: 's1' as Id<Source>,
        pos: { x: 25, y: 26, findInRange: vi.fn(() => []) },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 's1') return source;
        if (id === 'c1') return container;
        return undefined;
      }) as any;

      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as Id<Source>, x: 10, y: 20, containerId: 'c1' as Id<StructureContainer> },
        ],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      miner.run(creep);

      expect(creep.repair).not.toHaveBeenCalled();
      expect(creep.harvest).toHaveBeenCalledWith(source);
    });

    it('prioritizes building over repairing in remote rooms', () => {
      const site = {
        id: 'site1',
        structureType: STRUCTURE_CONTAINER,
      };
      const container = {
        id: 'rc1' as Id<StructureContainer>,
        hits: 200000,
        hitsMax: 250000,
        pos: { x: 25, y: 25, roomName: 'W1N1' },
      };
      const source = {
        id: 'rs1' as Id<Source>,
        pos: {
          x: 25,
          y: 26,
          findInRange: vi.fn((type: number) => {
            if (type === FIND_MY_CONSTRUCTION_SITES) return [site];
            return [];
          }),
        },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'rs1') return source;
        if (id === 'rc1') return container;
        return undefined;
      }) as any;

      Memory.rooms['W2N1'] = {
        sources: [
          {
            id: 'rs1' as Id<Source>,
            x: 5,
            y: 15,
            containerId: 'rc1' as Id<StructureContainer>,
          },
        ],
      } as any;

      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 'rs1', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W2N1' }),
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      miner.run(creep);

      expect(creep.build).toHaveBeenCalledWith(site);
      expect(creep.repair).not.toHaveBeenCalled();
    });

    it('returns to POSITION when displaced from container (push race condition)', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        hits: 250000,
        hitsMax: 250000,
        pos: { x: 10, y: 10, roomName: 'W1N1' },
      };
      const source = {
        id: 's1' as Id<Source>,
        pos: { x: 10, y: 11, findInRange: vi.fn(() => []) },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 's1') return source;
        if (id === 'c1') return container;
        return undefined;
      }) as any;

      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as Id<Source>, x: 10, y: 11, containerId: 'c1' as Id<StructureContainer> },
        ],
      } as any;

      // Creep at (25,25) — not on the container at (10,10) — simulates a push displacement
      const creep = mockCreep({
        memory: { role: 'miner', state: 'HARVEST', targetId: 's1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      miner.run(creep);

      expect(creep.memory.state).toBe('POSITION');
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
          x: 25,
          y: 25,
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
