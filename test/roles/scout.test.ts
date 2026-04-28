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
        controller: { owner: undefined, reservation: undefined },
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

    it('records owner and reservation', () => {
      const targetRoom = mockRoom({
        name: 'W2N1',
        controller: {
          owner: { username: 'EnemyPlayer' },
          reservation: { username: 'ReserverBot' },
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

    it('marks room unreachable after 50 ticks stuck', () => {
      Game.time = 200;
      const creep = mockCreep({
        memory: {
          role: 'scout',
          state: 'SCOUT',
          targetRoom: 'W2N1',
          _scoutTick: 100,
        },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(Memory.rooms['W2N1'].scoutedAt).toBe(200);
      expect(Memory.rooms['W2N1'].scoutedSources).toBe(0);
      expect(creep.memory.targetRoom).toBeUndefined();
      expect(creep.memory._scoutTick).toBeUndefined();
    });

    it('does not mark unreachable before 50 ticks', () => {
      Game.time = 140;
      const creep = mockCreep({
        memory: {
          role: 'scout',
          state: 'SCOUT',
          targetRoom: 'W2N1',
          _scoutTick: 100,
        },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(48, 25, 'W1N1'),
      });

      scout.run(creep);

      expect(creep.memory.targetRoom).toBe('W2N1');
    });
  });
});
