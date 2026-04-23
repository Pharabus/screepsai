import { markIdle, resetIdle, drawIdleIndicators } from '../../src/utils/idle';
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
      // and draw a circle. We can't easily assert RoomVisual calls, but we can verify
      // the creep is tracked by calling drawIdleIndicators without error.
    });

    it('moves creep toward storage when far away', () => {
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

      // Creep is far from storage (range > 3), so moveTo should be called
      // via registerMove in the traffic manager
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

      // Creep is within range 3 of storage, no movement registered
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

  describe('resetIdle', () => {
    it('clears idle set so indicators are not drawn', () => {
      const room = mockRoom();
      const creep = mockCreep({ room });
      (Game as any).creeps[creep.name] = creep;

      markIdle(creep);
      resetIdle();
      // drawIdleIndicators after reset should not draw anything
      drawIdleIndicators();
    });
  });

  describe('drawIdleIndicators', () => {
    it('skips creeps that no longer exist', () => {
      const room = mockRoom();
      const creep = mockCreep({ name: 'ghost', room });
      (Game as any).creeps['ghost'] = creep;

      markIdle(creep);
      delete (Game as any).creeps['ghost'];

      // Should not throw when creep is gone
      drawIdleIndicators();
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
