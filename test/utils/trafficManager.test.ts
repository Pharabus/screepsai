import {
  registerMove,
  registerStationary,
  resolveTraffic,
  resetTraffic,
  PRIORITY_HAULER,
  PRIORITY_WORKER,
  PRIORITY_STATIC,
} from '../../src/utils/trafficManager';
import { resetTickCache } from '../../src/utils/tickCache';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

describe('trafficManager', () => {
  const origSearch = (globalThis as any).PathFinder.search;

  beforeEach(() => {
    resetGameGlobals();
    resetTraffic();
    resetTickCache();
    (globalThis as any).PathFinder.search = origSearch;
  });

  describe('registerMove', () => {
    it('does not register intent when already in range', () => {
      const creep = mockCreep({
        name: 'c1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room: mockRoom({ find: vi.fn(() => []) }),
      });

      registerMove(creep, new RoomPosition(26, 26, 'W1N1'), PRIORITY_HAULER, 1);
      resolveTraffic();

      expect(creep.move).not.toHaveBeenCalled();
    });
  });

  describe('registerStationary', () => {
    it('claims current tile', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const creep1 = mockCreep({
        name: 'static1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
      });
      const creep2 = mockCreep({
        name: 'mover1',
        pos: new RoomPosition(24, 25, 'W1N1'),
        room,
      });
      (Game as any).creeps = { static1: creep1, mover1: creep2 };

      registerStationary(creep1, PRIORITY_STATIC);
      registerMove(creep2, new RoomPosition(25, 25, 'W1N1'), PRIORITY_HAULER, 0);
      resolveTraffic();

      // Static creep should not move
      expect(creep1.move).not.toHaveBeenCalled();
    });
  });

  describe('swaps', () => {
    it('both creeps move during a direct swap', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const posA = new RoomPosition(25, 25, 'W1N1');
      const posB = new RoomPosition(26, 25, 'W1N1');
      const creepA = mockCreep({ name: 'hauler_a', pos: posA, room });
      const creepB = mockCreep({ name: 'hauler_b', pos: posB, room });
      (Game as any).creeps = { hauler_a: creepA, hauler_b: creepB };

      (globalThis as any).PathFinder.search = (_origin: any, goal: any) => ({
        path: [goal.pos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      registerMove(creepA, posB, PRIORITY_HAULER, 0);
      registerMove(creepB, posA, PRIORITY_HAULER, 0);
      resolveTraffic();

      // Both should get move commands for a valid 2-way swap
      expect(creepA.move).toHaveBeenCalled();
      expect(creepB.move).toHaveBeenCalled();
    });

    it('swap works across different priorities', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const posA = new RoomPosition(25, 25, 'W1N1');
      const posB = new RoomPosition(26, 25, 'W1N1');
      const creepA = mockCreep({ name: 'aaa', pos: posA, room });
      const creepB = mockCreep({ name: 'bbb', pos: posB, room });
      (Game as any).creeps = { aaa: creepA, bbb: creepB };

      (globalThis as any).PathFinder.search = (_origin: any, goal: any) => ({
        path: [goal.pos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      registerMove(creepA, posB, PRIORITY_HAULER, 0);
      registerMove(creepB, posA, PRIORITY_STATIC, 0);
      resolveTraffic();

      expect(creepA.move).toHaveBeenCalled();
      expect(creepB.move).toHaveBeenCalled();
    });
  });

  describe('cycle breaking', () => {
    it('breaks 3-way cycle by removing lowest priority move', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const posA = new RoomPosition(25, 25, 'W1N1');
      const posB = new RoomPosition(26, 25, 'W1N1');
      const posC = new RoomPosition(26, 26, 'W1N1');
      const creepA = mockCreep({ name: 'a', pos: posA, room });
      const creepB = mockCreep({ name: 'b', pos: posB, room });
      const creepC = mockCreep({ name: 'c', pos: posC, room });
      (Game as any).creeps = { a: creepA, b: creepB, c: creepC };

      // A→B, B→C, C→A (3-way cycle)
      (globalThis as any).PathFinder.search = (_origin: any, goal: any) => ({
        path: [goal.pos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      registerMove(creepA, posB, PRIORITY_HAULER, 0);
      registerMove(creepB, posC, PRIORITY_HAULER, 0);
      registerMove(creepC, posA, PRIORITY_WORKER, 0); // lowest priority

      resolveTraffic();

      // C should be the one whose move is cancelled (lowest priority)
      expect(creepC.move).not.toHaveBeenCalled();
      // A and B should still get moves (chain resolves once cycle is broken)
      expect(creepA.move).toHaveBeenCalled();
      expect(creepB.move).toHaveBeenCalled();
    });

    it('does not break 2-way swaps', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const posA = new RoomPosition(25, 25, 'W1N1');
      const posB = new RoomPosition(26, 25, 'W1N1');
      const creepA = mockCreep({ name: 'a', pos: posA, room });
      const creepB = mockCreep({ name: 'b', pos: posB, room });
      (Game as any).creeps = { a: creepA, b: creepB };

      (globalThis as any).PathFinder.search = (_origin: any, goal: any) => ({
        path: [goal.pos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      registerMove(creepA, posB, PRIORITY_HAULER, 0);
      registerMove(creepB, posA, PRIORITY_HAULER, 0);
      resolveTraffic();

      // Both should move — 2-way swaps are valid
      expect(creepA.move).toHaveBeenCalled();
      expect(creepB.move).toHaveBeenCalled();
    });

    it('uses name as stable tiebreaker when priorities equal', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const posA = new RoomPosition(25, 25, 'W1N1');
      const posB = new RoomPosition(26, 25, 'W1N1');
      const posC = new RoomPosition(26, 26, 'W1N1');
      const creepA = mockCreep({ name: 'alpha', pos: posA, room });
      const creepB = mockCreep({ name: 'bravo', pos: posB, room });
      const creepC = mockCreep({ name: 'charlie', pos: posC, room });
      (Game as any).creeps = { alpha: creepA, bravo: creepB, charlie: creepC };

      (globalThis as any).PathFinder.search = (_origin: any, goal: any) => ({
        path: [goal.pos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      registerMove(creepA, posB, PRIORITY_HAULER, 0);
      registerMove(creepB, posC, PRIORITY_HAULER, 0);
      registerMove(creepC, posA, PRIORITY_HAULER, 0);
      resolveTraffic();

      // 'charlie' > 'bravo' > 'alpha', so charlie is removed (last alphabetically)
      expect(creepC.move).not.toHaveBeenCalled();
    });
  });

  describe('resetTraffic', () => {
    it('clears all intents', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const creep = mockCreep({
        name: 'c1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
      });
      (Game as any).creeps = { c1: creep };

      registerMove(creep, new RoomPosition(30, 30, 'W1N1'), PRIORITY_HAULER, 0);
      resetTraffic();
      resolveTraffic();

      expect(creep.move).not.toHaveBeenCalled();
    });
  });
});
