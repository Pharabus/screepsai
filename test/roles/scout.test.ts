import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { scout, findScoutTarget } from '../../src/roles/scout';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/idle', () => ({
  markIdle: vi.fn(),
}));

import { moveTo } from '../../src/utils/movement';
import { markIdle } from '../../src/utils/idle';

describe('scout', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  describe('findScoutTarget', () => {
    it('returns unscouted room', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W1N1'] = {};
      Memory.rooms['W1N2'] = { scoutedAt: 100 } as any;

      expect(findScoutTarget('W1N1')).toBe('W2N1');
    });

    it('returns undefined when all rooms are freshly scouted', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: Game.time } as any;

      expect(findScoutTarget('W1N1')).toBeUndefined();
    });

    it('returns stale room for re-scout', () => {
      Game.time = 10000;
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: 4000 } as any;

      expect(findScoutTarget('W1N1')).toBe('W2N1');
    });
  });

  describe('target picking', () => {
    it('picks unscouted rooms first', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W1N1'] = {};
      Memory.rooms['W1N2'] = { scoutedAt: 100 } as any;

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      scout.run(creep);

      expect(creep.memory.targetRoom).toBe('W2N1');
    });

    it('finds unscouted room at depth 2 when depth-1 rooms are scouted', () => {
      Game.time = 100;
      // W1N1 → W2N1 (scouted) → W3N1 (unscouted)
      Game.map.describeExits = (room: string) => {
        if (room === 'W1N1') return { '1': 'W2N1' } as any;
        if (room === 'W2N1') return { '1': 'W3N1' } as any;
        return {} as any;
      };
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100 } as any;

      expect(findScoutTarget('W1N1')).toBe('W3N1');
    });

    it('does not target rooms beyond SCOUT_MAX_DEPTH (depth 3)', () => {
      Game.time = 100;
      // W1N1 → W2N1 → W3N1 → W4N1 → W5N1 (depth 4, should NOT be picked)
      Game.map.describeExits = (room: string) => {
        if (room === 'W1N1') return { '1': 'W2N1' } as any;
        if (room === 'W2N1') return { '1': 'W3N1' } as any;
        if (room === 'W3N1') return { '1': 'W4N1' } as any;
        if (room === 'W4N1') return { '1': 'W5N1' } as any;
        return {} as any;
      };
      // All rooms through depth 3 scouted; only depth-4 would remain.
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100 } as any;
      Memory.rooms['W3N1'] = { scoutedAt: 100 } as any;
      Memory.rooms['W4N1'] = { scoutedAt: 100 } as any;

      expect(findScoutTarget('W1N1')).toBeUndefined();
    });

    it('skips rooms already in remoteRooms list', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: ['W2N1'] } as any;

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      scout.run(creep);

      expect(creep.memory.targetRoom).toBe('W1N2');
    });

    it('re-scouts rooms with stale data (>5000 ticks)', () => {
      Game.time = 10000;
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: 9000, scoutedSources: 1 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 4000, scoutedSources: 2 } as any;

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      scout.run(creep);

      expect(creep.memory.targetRoom).toBe('W1N2');
    });

    it('never re-targets owned rooms, even when stale', () => {
      Game.time = 100_000; // very stale
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 0,
        scoutedOwner: 'Bosko',
      } as any;

      expect(findScoutTarget('W1N1')).toBeUndefined();
    });

    it('expands BFS past an owned room to reach unscouted rooms behind it', () => {
      Game.time = 100;
      // W1N1 → W2N1 (owned by Bosko) → W3N1 (unscouted)
      Game.map.describeExits = (room: string) => {
        if (room === 'W1N1') return { '1': 'W2N1' } as any;
        if (room === 'W2N1') return { '1': 'W3N1' } as any;
        return {} as any;
      };
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedOwner: 'Bosko',
      } as any;

      expect(findScoutTarget('W1N1')).toBe('W3N1');
    });

    it('marks idle when no scout targets available', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W1N1'] = { remoteRooms: [] } as any;
      Memory.rooms['W2N1'] = { scoutedAt: Game.time } as any;

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      scout.run(creep);

      expect(markIdle).toHaveBeenCalledWith(creep);
      expect(creep.memory.targetRoom).toBeUndefined();
    });
  });

  describe('data recording', () => {
    it('records source data when arriving in target room', () => {
      const sources = [
        { id: 'src1' as Id<Source>, pos: { x: 10, y: 20 } },
        { id: 'src2' as Id<Source>, pos: { x: 30, y: 40 } },
      ];
      Game.time = 500;

      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: { owner: undefined, reservation: undefined, pos: { x: 25, y: 25 } },
        find: vi.fn((type: number) => {
          if (type === FIND_SOURCES) return sources;
          if (type === FIND_HOSTILE_CREEPS) return [];
          return [];
        }),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      const rmem = Memory.rooms['W2N1'];
      expect(rmem.scoutedSources).toBe(2);
      expect(rmem.scoutedAt).toBe(500);
      expect(rmem.scoutedSourceData).toEqual([
        { id: 'src1', x: 10, y: 20 },
        { id: 'src2', x: 30, y: 40 },
      ]);
      expect(rmem.scoutedHostiles).toBe(0);
      expect(creep.memory.targetRoom).toBeUndefined();
    });

    it('records controller position when controller exists', () => {
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: {
          owner: undefined,
          reservation: undefined,
          pos: { x: 31, y: 14 },
        },
        find: vi.fn(() => []),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedControllerPos).toEqual({ x: 31, y: 14 });
    });

    it('records mineral type and position when room has a mineral', () => {
      const mineral = {
        mineralType: 'L',
        pos: { x: 42, y: 19 },
      };
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_MINERALS) return [mineral];
          return [];
        }),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedMineral).toEqual({
        type: 'L',
        x: 42,
        y: 19,
      });
    });

    it('does not record mineral when room has none', () => {
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedMineral).toBeUndefined();
    });

    it('records owner and reservation', () => {
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: {
          owner: { username: 'EnemyPlayer' },
          reservation: { username: 'ReserverBot' },
          pos: { x: 25, y: 25 },
        },
        find: vi.fn(() => []),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedOwner).toBe('EnemyPlayer');
      expect(Memory.rooms['W2N1'].scoutedReservation).toBe('ReserverBot');
    });

    it('records ruins, tombstones, and large drops in scoutedLoot', () => {
      Game.time = 700;
      const ruin = {
        id: 'ruin1',
        pos: { x: 11, y: 12 },
        store: {
          getUsedCapacity: vi.fn((r?: string) => {
            if (r === undefined) return 4500;
            if (r === RESOURCE_ENERGY) return 4000;
            return 0;
          }),
        },
      };
      const tomb = {
        id: 'tomb1',
        pos: { x: 21, y: 22 },
        store: {
          getUsedCapacity: vi.fn((r?: string) => {
            if (r === undefined) return 300;
            if (r === RESOURCE_ENERGY) return 300;
            return 0;
          }),
        },
      };
      const bigDrop = {
        id: 'drop1',
        pos: { x: 31, y: 32 },
        amount: 1500,
        resourceType: RESOURCE_ENERGY,
      };
      const smallDrop = {
        id: 'drop2',
        pos: { x: 33, y: 34 },
        amount: 200,
        resourceType: RESOURCE_ENERGY,
      };

      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_RUINS) return [ruin];
          if (type === FIND_TOMBSTONES) return [tomb];
          if (type === FIND_DROPPED_RESOURCES) return [bigDrop, smallDrop];
          return [];
        }),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      const loot = Memory.rooms['W2N1'].scoutedLoot!;
      expect(loot.recordedAt).toBe(700);
      expect(loot.ruins).toEqual([{ id: 'ruin1', x: 11, y: 12, energy: 4000, total: 4500 }]);
      expect(loot.tombstones).toEqual([{ id: 'tomb1', x: 21, y: 22, energy: 300, total: 300 }]);
      // Only the >=1000 drop should appear
      expect(loot.drops).toEqual([
        { id: 'drop1', x: 31, y: 32, resourceType: RESOURCE_ENERGY, amount: 1500 },
      ]);
    });

    it('clears scoutedLoot when room has no abandoned resources', () => {
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn(() => []),
      });

      Memory.rooms['W2N1'] = {
        scoutedLoot: {
          recordedAt: 100,
          ruins: [{ id: 'old' as any, x: 1, y: 1, energy: 0, total: 0 }],
        },
      } as any;

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedLoot).toBeUndefined();
    });

    it('skips empty ruins and tombstones', () => {
      const emptyRuin = {
        id: 'ruin1',
        pos: { x: 11, y: 12 },
        store: { getUsedCapacity: () => 0 },
      };
      const emptyTomb = {
        id: 'tomb1',
        pos: { x: 21, y: 22 },
        store: { getUsedCapacity: () => 0 },
      };

      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_RUINS) return [emptyRuin];
          if (type === FIND_TOMBSTONES) return [emptyTomb];
          return [];
        }),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedLoot).toBeUndefined();
    });

    it('records hostile count', () => {
      const hostiles = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }];
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_HOSTILE_CREEPS) return hostiles;
          return [];
        }),
      });

      Memory.rooms['W2N1'] = {};

      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: targetRoom,
        pos: new RoomPosition(25, 25, 'W2N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedHostiles).toBe(3);
    });
  });

  describe('movement and stuck detection', () => {
    it('moves toward target room center when not there', () => {
      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 25, y: 25, roomName: 'W2N1' }),
        expect.objectContaining({ range: 20 }),
      );
    });

    it('sets _scoutTick when starting to path', () => {
      Game.time = 100;
      const creep = mockCreep({
        memory: { role: 'scout', state: 'SCOUT', targetRoom: 'W2N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(creep.memory._scoutTick).toBe(100);
    });

    it('marks room unreachable after 300 ticks stuck', () => {
      Game.time = 302;
      const creep = mockCreep({
        memory: {
          role: 'scout',
          state: 'SCOUT',
          targetRoom: 'W2N1',
          _scoutTick: 1,
        },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedAt).toBe(302);
      expect(Memory.rooms['W2N1'].scoutedSources).toBe(0);
      expect(creep.memory.targetRoom).toBeUndefined();
      expect(creep.memory._scoutTick).toBeUndefined();
    });

    it('does not mark unreachable before 300 ticks', () => {
      Game.time = 300;
      const creep = mockCreep({
        memory: {
          role: 'scout',
          state: 'SCOUT',
          targetRoom: 'W2N1',
          _scoutTick: 1,
        },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(creep.memory.targetRoom).toBe('W2N1');
    });
  });
});
