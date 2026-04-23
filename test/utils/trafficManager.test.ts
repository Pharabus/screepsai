import {
  registerStationary,
  resetTraffic,
  executeMove,
  getRoomCostMatrix,
  PRIORITY_STATIC,
} from '../../src/utils/trafficManager';
import { resetTickCache } from '../../src/utils/tickCache';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

describe('trafficManager', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTraffic();
    resetTickCache();
  });

  describe('getRoomCostMatrix', () => {
    it('sets roads to cost 1', () => {
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) {
            return [{ structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } }];
          }
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(10, 10)).toBe(1);
    });

    it('sets impassable structures to 255', () => {
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) {
            return [{ structureType: STRUCTURE_EXTENSION, pos: { x: 15, y: 15 } }];
          }
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(15, 15)).toBe(255);
    });

    it('keeps containers walkable', () => {
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) {
            return [{ structureType: STRUCTURE_CONTAINER, pos: { x: 12, y: 12 } }];
          }
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(12, 12)).toBe(0);
    });

    it('keeps own ramparts walkable', () => {
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) {
            return [{ structureType: STRUCTURE_RAMPART, my: true, pos: { x: 20, y: 20 } }];
          }
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(20, 20)).toBe(0);
    });

    it('sets regular creeps to cost 15', () => {
      const creep = mockCreep({ name: 'worker1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(10, 10)).toBe(15);
    });

    it('sets stationary creeps to cost 255', () => {
      const creep = mockCreep({ name: 'miner1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      registerStationary(creep, PRIORITY_STATIC);
      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(10, 10)).toBe(255);
    });

    it('clears stationary set on resetTraffic', () => {
      const creep = mockCreep({ name: 'miner1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      registerStationary(creep, PRIORITY_STATIC);
      resetTraffic();
      resetTickCache();
      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(10, 10)).toBe(15);
    });

    it('sets hostile creeps to cost 255', () => {
      const hostile = { pos: { x: 30, y: 30 } };
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_HOSTILE_CREEPS) return [hostile];
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(30, 30)).toBe(255);
    });
  });

  describe('executeMove', () => {
    it('calls creep.move with correct direction', () => {
      const room = mockRoom({ find: vi.fn(() => []) });
      const creep = mockCreep({
        name: 'c1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
      });

      (globalThis as any).PathFinder.search = () => ({
        path: [new RoomPosition(26, 25, 'W1N1')],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      executeMove(creep, new RoomPosition(30, 25, 'W1N1'), 0);
      expect(creep.move).toHaveBeenCalled();
    });

    it('skips movement when already in range', () => {
      const creep = mockCreep({
        name: 'c1',
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      executeMove(creep, new RoomPosition(26, 25, 'W1N1'), 1);
      expect(creep.move).not.toHaveBeenCalled();
    });
  });
});
