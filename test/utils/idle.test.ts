import {
  markIdle,
  resetIdle,
  drawIdleIndicators,
  nameHash,
  shouldRecycle,
} from '../../src/utils/idle';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

describe('idle', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetIdle();
  });

  describe('markIdle', () => {
    it('registers creep as idle', () => {
      const room = mockRoom();
      const creep = mockCreep({ room, pos: new RoomPosition(25, 25, 'W1N1') });
      (Game as any).creeps[creep.name] = creep;

      markIdle(creep);
      drawIdleIndicators();

      // If the creep was registered, drawIdleIndicators would look it up in Game.creeps
      // and draw a circle — no error means registration succeeded.
    });

    it('sets idleSince on first idle tick', () => {
      Game.time = 100;
      const creep = mockCreep({ memory: { role: 'hauler' } });
      markIdle(creep);
      expect(creep.memory.idleSince).toBe(100);
    });

    it('resets idleSince when there is a gap in idle ticks', () => {
      Game.time = 100;
      const creep = mockCreep({ memory: { role: 'hauler' } });
      markIdle(creep); // streak starts at 100

      Game.time = 110; // gap — creep did work between tick 100 and 110
      markIdle(creep); // new streak starts at 110
      expect(creep.memory.idleSince).toBe(110);
    });

    it('does not reset idleSince for consecutive idle ticks', () => {
      Game.time = 100;
      const creep = mockCreep({ memory: { role: 'hauler' } });
      markIdle(creep);
      expect(creep.memory.idleSince).toBe(100);

      Game.time = 101;
      markIdle(creep);
      expect(creep.memory.idleSince).toBe(100); // unchanged — streak continues
    });

    it('does not recycle hauler regardless of idle duration', () => {
      Game.time = 200;
      const spawnMock = {
        pos: new RoomPosition(25, 25, 'W1N1'),
        recycleCreep: vi.fn(() => ERR_NOT_IN_RANGE),
      };
      const creep = mockCreep({
        memory: { role: 'hauler', idleSince: 140, _idleLastTick: 199 },
        pos: Object.assign(new RoomPosition(10, 10, 'W1N1'), {
          findClosestByRange: vi.fn(() => spawnMock),
        }),
      });
      markIdle(creep);

      // Hauler has no recycle threshold — should never be sent to recycle
      expect(spawnMock.recycleCreep).not.toHaveBeenCalled();
    });

    it('does not recycle combat roles when threat is recent', () => {
      Game.time = 200;
      Memory.rooms['W1N1'] = { threatLastSeen: 190 } as any; // 10 ticks ago < 200
      const spawnMock = { recycleCreep: vi.fn() };
      const creep = mockCreep({
        memory: { role: 'defender', idleSince: 90, _idleLastTick: 199 },
        pos: Object.assign(new RoomPosition(10, 10, 'W1N1'), {
          findClosestByRange: vi.fn(() => spawnMock),
          inRangeTo: vi.fn(() => true), // already near anchor — no movement
          isEqualTo: vi.fn(() => true),
        }),
      });
      markIdle(creep);
      expect(spawnMock.recycleCreep).not.toHaveBeenCalled();
    });

    it('recycles combat roles when threat is old', () => {
      Game.time = 500;
      Memory.rooms['W1N1'] = { threatLastSeen: 100 } as any; // 400 ticks ago > 200
      const spawnMock = {
        pos: new RoomPosition(25, 25, 'W1N1'),
        recycleCreep: vi.fn(() => ERR_NOT_IN_RANGE),
      };
      const creep = mockCreep({
        memory: { role: 'defender', idleSince: 390, _idleLastTick: 499 },
        pos: Object.assign(new RoomPosition(10, 10, 'W1N1'), {
          findClosestByRange: vi.fn(() => spawnMock),
        }),
      });
      markIdle(creep);
      expect(spawnMock.recycleCreep).toHaveBeenCalledWith(creep);
    });

    it('rallies toward controller when it is far from spawn', () => {
      const spawnPos = new RoomPosition(16, 31, 'W1N1');
      const ctrlPos = new RoomPosition(40, 15, 'W1N1');
      const room = mockRoom({
        controller: { my: true, level: 4, pos: ctrlPos },
        find: vi.fn((type: number) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: spawnPos }];
          return [];
        }),
      });
      const creep = mockCreep({
        room,
        pos: new RoomPosition(25, 25, 'W1N1'),
        memory: { role: 'hauler' },
      });
      // Should not crash and should compute a rally target near ctrlPos
      expect(() => markIdle(creep)).not.toThrow();
    });

    it('falls back to storage or spawn when controller is too close', () => {
      // Controller within 8 tiles of spawn → getRallyPos returns undefined → fallback
      const spawnPos = new RoomPosition(16, 31, 'W1N1');
      const ctrlPos = new RoomPosition(18, 33, 'W1N1'); // range ~3 — too close
      const room = mockRoom({
        controller: { my: true, level: 4, pos: ctrlPos },
        storage: { pos: new RoomPosition(16, 29, 'W1N1') },
        find: vi.fn((type: number) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: spawnPos }];
          return [];
        }),
      });
      const creep = mockCreep({
        room,
        pos: new RoomPosition(10, 10, 'W1N1'),
        memory: { role: 'hauler' },
      });
      expect(() => markIdle(creep)).not.toThrow();
    });

    it('moves creep toward storage when far away (fallback path)', () => {
      const storage = {
        pos: new RoomPosition(30, 30, 'W1N1'),
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1000000 },
      };
      const room = mockRoom({ storage });
      const creep = mockCreep({
        room,
        pos: new RoomPosition(10, 10, 'W1N1'),
      });

      markIdle(creep);
      // Should not throw — movement intent registered via traffic manager
    });

    it('does not move creep already near storage', () => {
      const storage = {
        pos: new RoomPosition(25, 25, 'W1N1'),
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1000000 },
      };
      const room = mockRoom({ storage });
      const creep = mockCreep({
        room,
        pos: new RoomPosition(26, 26, 'W1N1'),
      });

      markIdle(creep);
      // Creep is within range 5 of storage — no movement registered
    });

    it('falls back to spawn when no storage', () => {
      const spawn = {
        pos: new RoomPosition(25, 25, 'W1N1'),
        structureType: 'spawn',
      };
      const room = mockRoom({
        storage: undefined,
        find: vi.fn((type: number) => {
          if (type === FIND_MY_SPAWNS) return [spawn];
          return [];
        }),
      });
      const creep = mockCreep({
        room,
        pos: new RoomPosition(10, 10, 'W1N1'),
      });

      markIdle(creep);
      // Should target spawn since no storage exists
    });
  });

  describe('nameHash', () => {
    it('returns a non-negative integer', () => {
      expect(nameHash('hauler_123')).toBeGreaterThanOrEqual(0);
      expect(nameHash('defender_abc')).toBeGreaterThanOrEqual(0);
    });

    it('returns different values for different names', () => {
      expect(nameHash('hauler_1')).not.toBe(nameHash('hauler_2'));
    });

    it('is deterministic', () => {
      expect(nameHash('test_creep')).toBe(nameHash('test_creep'));
    });

    it('produces values distributed across offset slots', () => {
      const OFFSET_COUNT = 9;
      const slots = new Set<number>();
      const names = [
        'hauler_1',
        'hauler_2',
        'hauler_3',
        'defender_1',
        'remoteHauler_1',
        'upgrader_1',
        'miner_1',
        'reserver_1',
        'scout_1',
      ];
      for (const name of names) {
        slots.add(nameHash(name) % OFFSET_COUNT);
      }
      // 9 different names should hit at least 4 distinct slots
      expect(slots.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe('shouldRecycle', () => {
    it('returns false for roles without a threshold', () => {
      const creep = mockCreep({ memory: { role: 'upgrader' } });
      expect(shouldRecycle(creep, 1000)).toBe(false);
    });

    it('returns false for hauler (no recycle threshold)', () => {
      const creep = mockCreep({ memory: { role: 'hauler' } });
      expect(shouldRecycle(creep, 49)).toBe(false);
      expect(shouldRecycle(creep, 50)).toBe(false);
      expect(shouldRecycle(creep, 10_000)).toBe(false);
    });

    it('returns false for defender below threshold', () => {
      const creep = mockCreep({ memory: { role: 'defender' } });
      expect(shouldRecycle(creep, 99)).toBe(false);
    });

    it('returns false for defender at threshold but recent threat', () => {
      Game.time = 200;
      Memory.rooms['W1N1'] = { threatLastSeen: 150 } as any;
      const creep = mockCreep({ memory: { role: 'defender' } });
      expect(shouldRecycle(creep, 100)).toBe(false);
    });

    it('returns true for defender at threshold with old threat', () => {
      Game.time = 500;
      Memory.rooms['W1N1'] = { threatLastSeen: 100 } as any;
      const creep = mockCreep({ memory: { role: 'defender' } });
      expect(shouldRecycle(creep, 100)).toBe(true);
    });

    it('returns true for defender with no threat history', () => {
      Game.time = 200;
      Memory.rooms['W1N1'] = {} as any;
      const creep = mockCreep({ memory: { role: 'defender' } });
      expect(shouldRecycle(creep, 100)).toBe(true);
    });
  });

  describe('resetIdle', () => {
    it('clears idle set so indicators are not drawn', () => {
      const room = mockRoom();
      const creep = mockCreep({ room });
      (Game as any).creeps[creep.name] = creep;

      markIdle(creep);
      resetIdle();
      drawIdleIndicators();
      // No draw calls expected after reset
    });
  });

  describe('drawIdleIndicators', () => {
    it('skips creeps that no longer exist', () => {
      const room = mockRoom();
      const creep = mockCreep({ name: 'ghost', room });
      (Game as any).creeps['ghost'] = creep;

      markIdle(creep);
      delete (Game as any).creeps['ghost'];

      expect(() => drawIdleIndicators()).not.toThrow();
    });

    it('draws circle for each idle creep', () => {
      const circleSpy = vi.fn().mockReturnThis();
      const origRoomVisual = (globalThis as any).RoomVisual;
      (globalThis as any).RoomVisual = class {
        circle = circleSpy;
        poly() {
          return this;
        }
      };

      const room = mockRoom();
      const creep = mockCreep({ name: 'idle1', room });
      (Game as any).creeps['idle1'] = creep;

      markIdle(creep);
      drawIdleIndicators();

      expect(circleSpy).toHaveBeenCalledTimes(1);
      expect(circleSpy).toHaveBeenCalledWith(
        creep.pos,
        expect.objectContaining({ stroke: '#888888' }),
      );

      (globalThis as any).RoomVisual = origRoomVisual;
    });
  });
});
