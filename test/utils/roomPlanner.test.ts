import { resetGameGlobals, mockRoom } from '../mocks/screeps';
import {
  ensureRoomPlan,
  ensureRemoteRoomPlan,
  findUnminedSource,
  assignMiner,
  needsMineralMiner,
  assignMineralMiner,
} from '../../src/utils/roomPlanner';

describe('roomPlanner', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  describe('ensureRoomPlan', () => {
    it('discovers sources on first call', () => {
      const sources = [
        { id: 's1' as Id<Source>, pos: { x: 10, y: 20 } },
        { id: 's2' as Id<Source>, pos: { x: 30, y: 40 } },
      ];
      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_SOURCES) return sources;
          return [];
        }),
      });

      Memory.rooms['W1N1'] = {};
      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].sources).toEqual([
        { id: 's1', x: 10, y: 20 },
        { id: 's2', x: 30, y: 40 },
      ]);
    });

    it('does not re-scan sources if already present with position data', () => {
      const findFn = vi.fn(() => []);
      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: findFn,
      });

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      ensureRoomPlan(room);

      expect(findFn).not.toHaveBeenCalledWith(FIND_SOURCES);
    });

    it('assigns container to source when found within range 1', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
      };
      const sourceObj = {
        id: 's1' as Id<Source>,
        pos: {
          x: 10,
          y: 20,
          findInRange: vi.fn(() => [container]),
        },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 's1') return sourceObj;
        return undefined;
      }) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].sources![0]!.containerId).toBe('c1');
    });

    it('clears dead container assignment', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as Id<Source>, x: 10, y: 20, containerId: 'dead' as Id<StructureContainer> },
        ],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].sources![0]!.containerId).toBeUndefined();
    });

    it('sets minerEconomy true when a source has a container', () => {
      const container = {
        id: 'c1' as Id<StructureContainer>,
        pos: new RoomPosition(10, 21, 'W1N1'),
      };
      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'c1') return container;
        return undefined;
      }) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [
          { id: 's1' as Id<Source>, x: 10, y: 20, containerId: 'c1' as Id<StructureContainer> },
        ],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].minerEconomy).toBe(true);
    });

    it('sets minerEconomy false when no containers', () => {
      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].minerEconomy).toBe(false);
    });

    it('clears dead miner assignment and restores orphaned miners', () => {
      const minerCreep = {
        name: 'miner_1',
        memory: { role: 'miner', targetId: 's1' },
      };
      Game.creeps = { miner_1: minerCreep } as any;
      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller: undefined,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20, minerName: 'dead_creep' }],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].sources![0]!.minerName).toBe('miner_1');
    });

    it('assigns controller container within range 3', () => {
      const controllerContainer = {
        id: 'cc1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
      };
      const controller = {
        my: true,
        level: 4,
        pos: {
          findInRange: vi.fn(() => [controllerContainer]),
        },
      };

      Game.getObjectById = vi.fn(() => undefined) as any;

      const room = mockRoom({
        name: 'W1N1',
        controller,
        storage: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      ensureRoomPlan(room);

      expect(Memory.rooms['W1N1'].controllerContainerId).toBe('cc1');
    });
  });

  describe('ensureRemoteRoomPlan', () => {
    it('discovers sources from visible room', () => {
      const sources = [{ id: 'rs1' as Id<Source>, pos: { x: 5, y: 15 } }];
      const remoteRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => sources),
      });
      Game.rooms['W2N1'] = remoteRoom;
      Memory.rooms['W2N1'] = {};

      ensureRemoteRoomPlan('W2N1');

      expect(Memory.rooms['W2N1'].sources).toEqual([{ id: 'rs1', x: 5, y: 15 }]);
    });

    it('bootstraps sources from scoutedSourceData without visibility', () => {
      Memory.rooms['W2N1'] = {
        scoutedSourceData: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      ensureRemoteRoomPlan('W2N1');

      expect(Memory.rooms['W2N1'].sources).toEqual([{ id: 'rs1', x: 5, y: 15 }]);
    });

    it('validates miner assignments without visibility', () => {
      Game.creeps = {};
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15, minerName: 'dead_miner' }],
      } as any;

      ensureRemoteRoomPlan('W2N1');

      expect(Memory.rooms['W2N1'].sources![0]!.minerName).toBeUndefined();
    });

    it('updates container assignments when room is visible', () => {
      const container = {
        id: 'rc1' as Id<StructureContainer>,
        structureType: STRUCTURE_CONTAINER,
      };
      const sourceObj = {
        id: 'rs1' as Id<Source>,
        pos: { findInRange: vi.fn(() => [container]) },
      };

      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'rs1') return sourceObj;
        return undefined;
      }) as any;

      const remoteRoom = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      Game.rooms['W2N1'] = remoteRoom;

      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      ensureRemoteRoomPlan('W2N1');

      expect(Memory.rooms['W2N1'].sources![0]!.containerId).toBe('rc1');
    });
  });

  describe('findUnminedSource', () => {
    it('returns source with container but no miner', () => {
      Memory.rooms['W1N1'] = {
        sources: [
          {
            id: 's1' as Id<Source>,
            x: 10,
            y: 20,
            containerId: 'c1' as Id<StructureContainer>,
            minerName: 'miner_1',
          },
          { id: 's2' as Id<Source>, x: 30, y: 40, containerId: 'c2' as Id<StructureContainer> },
        ],
      } as any;

      expect(findUnminedSource('W1N1')).toBe('s2');
    });

    it('returns undefined when all sources have miners', () => {
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

      expect(findUnminedSource('W1N1')).toBeUndefined();
    });

    it('skips sources without containers in local rooms', () => {
      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      expect(findUnminedSource('W1N1')).toBeUndefined();
    });

    it('allows containerless sources in remote rooms', () => {
      Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] } as any;
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'rs1' as Id<Source>, x: 5, y: 15 }],
      } as any;

      expect(findUnminedSource('W2N1')).toBe('rs1');
    });

    it('returns undefined when no sources data exists', () => {
      Memory.rooms['W1N1'] = {};
      expect(findUnminedSource('W1N1')).toBeUndefined();
    });
  });

  describe('assignMiner', () => {
    it('assigns creep name to matching source entry', () => {
      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      assignMiner('W1N1', 's1' as Id<Source>, 'miner_1');

      expect(Memory.rooms['W1N1'].sources![0]!.minerName).toBe('miner_1');
    });

    it('does nothing if source not found', () => {
      Memory.rooms['W1N1'] = {
        sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
      } as any;

      assignMiner('W1N1', 's_missing' as Id<Source>, 'miner_1');

      expect(Memory.rooms['W1N1'].sources![0]!.minerName).toBeUndefined();
    });
  });

  describe('needsMineralMiner', () => {
    it('returns true when mineral has amount and no miner assigned', () => {
      Memory.rooms['W1N1'] = {
        mineralId: 'm1' as Id<Mineral>,
        mineralContainerId: 'mc1' as Id<StructureContainer>,
      } as any;

      Game.getObjectById = vi.fn(() => ({ mineralAmount: 100 })) as any;

      expect(needsMineralMiner('W1N1')).toBe(true);
    });

    it('returns false when mineral is depleted', () => {
      Memory.rooms['W1N1'] = {
        mineralId: 'm1' as Id<Mineral>,
        mineralContainerId: 'mc1' as Id<StructureContainer>,
      } as any;

      Game.getObjectById = vi.fn(() => ({ mineralAmount: 0 })) as any;

      expect(needsMineralMiner('W1N1')).toBe(false);
    });

    it('returns false when miner already assigned and alive', () => {
      Memory.rooms['W1N1'] = {
        mineralId: 'm1' as Id<Mineral>,
        mineralContainerId: 'mc1' as Id<StructureContainer>,
        mineralMinerName: 'mm_1',
      } as any;

      Game.creeps = { mm_1: { name: 'mm_1' } } as any;

      expect(needsMineralMiner('W1N1')).toBe(false);
    });

    it('returns false without mineral container', () => {
      Memory.rooms['W1N1'] = {
        mineralId: 'm1' as Id<Mineral>,
      } as any;

      expect(needsMineralMiner('W1N1')).toBe(false);
    });
  });

  describe('assignMineralMiner', () => {
    it('sets mineralMinerName in room memory', () => {
      Memory.rooms['W1N1'] = {} as any;
      assignMineralMiner('W1N1', 'mm_1');
      expect(Memory.rooms['W1N1'].mineralMinerName).toBe('mm_1');
    });
  });
});
