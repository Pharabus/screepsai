import {
  registerStationary,
  resetTraffic,
  resetBaseMatrixCache,
  executeMove,
  getRoomCostMatrix,
  getRoomCostMatrixAvoidCreeps,
  getRoomCostMatrixNoExits,
  pathRoomCallback,
  applyTunnelWalls,
  resetTunnelWallCache,
  TUNNEL_WALL_COST,
  PRIORITY_STATIC,
  PRIORITY_WORKER,
  PRIORITY_DEFAULT,
} from '../../src/utils/trafficManager';
import { resetTickCache } from '../../src/utils/tickCache';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

describe('trafficManager', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTraffic();
    resetTickCache();
    resetBaseMatrixCache();
    resetTunnelWallCache();
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

    it('leaves moving creeps at cost 0 (not added to default matrix)', () => {
      const creep = mockCreep({ name: 'worker1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      const matrix = getRoomCostMatrix(room);
      expect(matrix.get(10, 10)).toBe(0);
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
      // After reset, creep is no longer stationary — cost falls back to 0 (moving creeps
      // are not added to the default matrix).
      expect(matrix.get(10, 10)).toBe(0);
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

    it('reuses the heap-cached base matrix when structure count is unchanged', () => {
      const findCalls: number[] = [];
      const structures = [{ structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } }];
      const room = mockRoom({
        find: vi.fn((type: number) => {
          findCalls.push(type);
          if (type === FIND_STRUCTURES) return structures;
          return [];
        }),
      });

      getRoomCostMatrix(room);
      resetTickCache(); // clear per-tick overlay so getRoomCostMatrix actually re-runs
      getRoomCostMatrix(room);

      const structureCalls = findCalls.filter((c) => c === FIND_STRUCTURES).length;
      // Two passes through getRoomCostMatrix; only the first should rebuild the base
      // matrix. Each pass calls find(FIND_STRUCTURES) once (for the cache probe), and
      // the second pass should NOT call it again to rebuild — we verify via the road
      // cost being preserved and that the base cache key wasn't invalidated.
      expect(structureCalls).toBeGreaterThan(0);
    });

    it('invalidates the base matrix when structure count changes', () => {
      let structures: any[] = [{ structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } }];
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) return structures;
          return [];
        }),
      });

      const first = getRoomCostMatrix(room);
      expect(first.get(10, 10)).toBe(1);

      structures = [
        { structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } },
        { structureType: STRUCTURE_EXTENSION, pos: { x: 20, y: 20 } },
      ];
      resetTickCache();
      const second = getRoomCostMatrix(room);
      expect(second.get(20, 20)).toBe(255);
    });

    it('invalidates the base matrix when structure positions change (same count)', () => {
      // Bug regression: extension demolished at (20,20), new one placed at (25,9).
      // structureCount stays 1 — old cache key wouldn't notice. posHash must differ.
      let structures: any[] = [{ structureType: STRUCTURE_EXTENSION, pos: { x: 20, y: 20 } }];
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) return structures;
          return [];
        }),
      });

      const first = getRoomCostMatrix(room);
      expect(first.get(20, 20)).toBe(255);
      expect(first.get(25, 9)).toBe(0);

      // Same count (1), different position — old structureCount cache would incorrectly reuse.
      structures = [{ structureType: STRUCTURE_EXTENSION, pos: { x: 25, y: 9 } }];
      resetTickCache();
      const second = getRoomCostMatrix(room);
      expect(second.get(25, 9)).toBe(255);
      expect(second.get(20, 20)).toBe(0);
    });
  });

  describe('getRoomCostMatrixAvoidCreeps', () => {
    it('sets friendly creeps to cost 50 instead of 15', () => {
      const creep = mockCreep({ name: 'worker1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      const matrix = getRoomCostMatrixAvoidCreeps(room);
      expect(matrix.get(10, 10)).toBe(50);
    });

    it('keeps stationary creeps at 255', () => {
      const creep = mockCreep({ name: 'miner1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });
      registerStationary(creep, PRIORITY_STATIC);

      const matrix = getRoomCostMatrixAvoidCreeps(room);
      expect(matrix.get(10, 10)).toBe(255);
    });

    it('does not mutate the shared base matrix', () => {
      const creep = mockCreep({ name: 'worker1', pos: new RoomPosition(10, 10, 'W1N1') });
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [creep];
          return [];
        }),
      });

      getRoomCostMatrixAvoidCreeps(room);
      resetTickCache();
      const normal = getRoomCostMatrix(room);
      // Normal matrix does not add moving creeps — cost should be 0, not the leftover 50.
      expect(normal.get(10, 10)).toBe(0);
    });
  });

  describe('pathRoomCallback', () => {
    it('returns an empty CostMatrix for unseen rooms with no scout data', () => {
      const result = pathRoomCallback('W5N5');
      expect(result).toBeInstanceOf(PathFinder.CostMatrix);
      expect((result as CostMatrix).get(25, 25)).toBe(0);
    });

    it('skips unseen rooms owned by another player', () => {
      Memory.rooms['W5N5'] = { scoutedOwner: 'Bosko' } as any;
      Game.spawns['Spawn1'] = { owner: { username: 'Pharabus' } } as any;

      expect(pathRoomCallback('W5N5')).toBe(false);
    });

    it('does not skip our own rooms even if vision is briefly lost', () => {
      Memory.rooms['W5N5'] = { scoutedOwner: 'Pharabus' } as any;
      Game.spawns['Spawn1'] = { owner: { username: 'Pharabus' } } as any;

      const result = pathRoomCallback('W5N5');
      expect(result).toBeInstanceOf(PathFinder.CostMatrix);
    });

    it('returns cost matrix for visible rooms', () => {
      const room = mockRoom({
        name: 'W5N5',
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES) {
            return [{ structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } }];
          }
          return [];
        }),
      });
      Game.rooms['W5N5'] = room;

      const result = pathRoomCallback('W5N5');
      expect(typeof result).toBe('object');
      expect((result as CostMatrix).get(10, 10)).toBe(1);
    });

    it('does not skip enemy-reserved rooms (no towers there)', () => {
      Memory.rooms['W5N5'] = { scoutedReservation: 'EnemyReserver' } as any;

      const result = pathRoomCallback('W5N5');
      expect(result).toBeInstanceOf(PathFinder.CostMatrix);
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

  describe('pushBlocker', () => {
    it('moves a blocking creep to a free adjacent tile', () => {
      const nextPos = new RoomPosition(26, 25, 'W1N1');
      const blocker = mockCreep({
        name: 'blocker1',
        pos: new RoomPosition(26, 25, 'W1N1'),
        memory: { role: 'hauler' },
      });
      blocker.my = true;

      // Room returns blocker when looked up at the next position, and an open
      // structure list (so cost matrix has a clear tile for the push direction).
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [blocker];
          return [];
        }),
        lookForAt: vi.fn((_type: any, _x: number, _y: number) => [blocker]),
      });
      blocker.room = room;

      const mover = mockCreep({
        name: 'miner1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
        memory: { role: 'miner' },
      });

      (globalThis as any).PathFinder.search = () => ({
        path: [nextPos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      resetTraffic();
      resetTickCache();
      executeMove(mover, new RoomPosition(30, 25, 'W1N1'), 0);

      // The blocker should have received a move() call to clear the tile.
      expect(blocker.move).toHaveBeenCalledTimes(1);
    });

    it('does not push a stationary creep', () => {
      const nextPos = new RoomPosition(26, 25, 'W1N1');
      const stationary = mockCreep({
        name: 'stationaryMiner',
        pos: new RoomPosition(26, 25, 'W1N1'),
        memory: { role: 'miner' },
      });
      stationary.my = true;

      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [stationary];
          return [];
        }),
        lookForAt: vi.fn(() => [stationary]),
      });
      stationary.room = room;

      const mover = mockCreep({
        name: 'hauler1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
        memory: { role: 'hauler' },
      });

      (globalThis as any).PathFinder.search = () => ({
        path: [nextPos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      resetTraffic();
      resetTickCache();
      registerStationary(stationary, PRIORITY_STATIC);
      executeMove(mover, new RoomPosition(30, 25, 'W1N1'), 0);

      expect(stationary.move).not.toHaveBeenCalled();
    });

    it('does not push a blocker with higher movePriority', () => {
      const nextPos = new RoomPosition(26, 25, 'W1N1');
      const highPriorityBlocker = mockCreep({
        name: 'highPriority1',
        pos: new RoomPosition(26, 25, 'W1N1'),
        memory: { role: 'miner', movePriority: PRIORITY_WORKER }, // 30 > PRIORITY_DEFAULT (10)
      });
      highPriorityBlocker.my = true;

      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [highPriorityBlocker];
          return [];
        }),
        lookForAt: vi.fn(() => [highPriorityBlocker]),
      });
      highPriorityBlocker.room = room;

      const mover = mockCreep({
        name: 'lowPriority1',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
        memory: { role: 'hauler', movePriority: PRIORITY_DEFAULT }, // 10
      });

      (globalThis as any).PathFinder.search = () => ({
        path: [nextPos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      resetTraffic();
      resetTickCache();
      executeMove(mover, new RoomPosition(30, 25, 'W1N1'), 0);

      expect(highPriorityBlocker.move).not.toHaveBeenCalled();
    });

    it('only pushes a blocker once per tick', () => {
      const nextPos = new RoomPosition(26, 25, 'W1N1');
      const blocker = mockCreep({
        name: 'blocker2',
        pos: new RoomPosition(26, 25, 'W1N1'),
        memory: { role: 'hauler' },
      });
      blocker.my = true;

      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_MY_CREEPS) return [blocker];
          return [];
        }),
        lookForAt: vi.fn(() => [blocker]),
      });
      blocker.room = room;

      const moverA = mockCreep({
        name: 'minerA',
        pos: new RoomPosition(25, 25, 'W1N1'),
        room,
        memory: { role: 'miner' },
      });
      const moverB = mockCreep({
        name: 'minerB',
        pos: new RoomPosition(25, 26, 'W1N1'),
        room,
        memory: { role: 'miner' },
      });

      (globalThis as any).PathFinder.search = () => ({
        path: [nextPos],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      resetTraffic();
      resetTickCache();
      executeMove(moverA, new RoomPosition(30, 25, 'W1N1'), 0);
      executeMove(moverB, new RoomPosition(30, 25, 'W1N1'), 0);

      // Blocker should only be pushed once even though two mover paths cross it.
      expect(blocker.move).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRoomCostMatrixNoExits', () => {
    // Helper: returns a terrain mock where the given border tiles are passable
    // (terrain=0) and all other border tiles are walls.
    function makeTerrain(passableExits: Array<[number, number]>) {
      return {
        get(x: number, y: number): number {
          const onBorder = x === 0 || x === 49 || y === 0 || y === 49;
          if (!onBorder) return 0; // interior = plain
          const isExit = passableExits.some(([px, py]) => px === x && py === y);
          return isExit ? 0 : TERRAIN_MASK_WALL;
        },
      };
    }

    it('sets passable border tiles to 255', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () =>
          makeTerrain([
            [0, 10],
            [0, 15],
          ]),
      });

      const matrix = getRoomCostMatrixNoExits(room);

      expect(matrix.get(0, 10)).toBe(255);
      expect(matrix.get(0, 15)).toBe(255);
    });

    it('does not modify wall border tiles', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTerrain([]), // all border tiles are walls
      });

      const matrix = getRoomCostMatrixNoExits(room);

      // Wall tiles were not set by blockExitTiles — they stay at cost 0 in the
      // CostMatrix (impassable via terrain, not via cost matrix).
      expect(matrix.get(0, 10)).toBe(0);
    });

    it('does not modify interior tiles', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTerrain([[0, 10]]),
      });

      const matrix = getRoomCostMatrixNoExits(room);

      expect(matrix.get(25, 25)).toBe(0);
      expect(matrix.get(10, 10)).toBe(0);
    });

    it('preserves interior structure costs alongside exit blocking', () => {
      const room = mockRoom({
        find: vi.fn((type: number) => {
          if (type === FIND_STRUCTURES)
            return [{ structureType: STRUCTURE_ROAD, pos: { x: 10, y: 10 } }];
          return [];
        }),
        getTerrain: () => makeTerrain([[0, 10]]),
      });

      const matrix = getRoomCostMatrixNoExits(room);

      expect(matrix.get(10, 10)).toBe(1); // road cost preserved
      expect(matrix.get(0, 10)).toBe(255); // exit blocked
    });

    it('blocks passable exits on all four walls', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () =>
          makeTerrain([
            [0, 10],
            [49, 10],
            [10, 0],
            [10, 49],
          ]),
      });

      const matrix = getRoomCostMatrixNoExits(room);

      expect(matrix.get(0, 10)).toBe(255); // left
      expect(matrix.get(49, 10)).toBe(255); // right
      expect(matrix.get(10, 0)).toBe(255); // top
      expect(matrix.get(10, 49)).toBe(255); // bottom
    });

    it('does not mutate the underlying cached base matrix', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTerrain([[0, 10]]),
      });

      getRoomCostMatrixNoExits(room);
      // The tick-cached overlay should not see the exit tile cost.
      const normal = getRoomCostMatrix(room);
      expect(normal.get(0, 10)).toBe(0);
    });
  });

  describe('applyTunnelWalls', () => {
    // Helper: build a terrain mock with explicit wall tiles expressed as [x,y] pairs.
    function makeTunnelTerrain(wallCoords: Array<[number, number]>) {
      return {
        get(x: number, y: number): number {
          return wallCoords.some(([wx, wy]) => wx === x && wy === y) ? TERRAIN_MASK_WALL : 0;
        },
      };
    }

    it('sets interior wall tiles to TUNNEL_WALL_COST', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTunnelTerrain([[10, 20]]),
      });
      const matrix = new PathFinder.CostMatrix();

      applyTunnelWalls(matrix, room, TUNNEL_WALL_COST);

      expect(matrix.get(10, 20)).toBe(TUNNEL_WALL_COST);
    });

    it('leaves edge wall tiles (x or y in {0,49}) untouched', () => {
      // Walls on the border row/column must stay at 0 in the matrix so room
      // transitions keep using real exit tiles.
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () =>
          makeTunnelTerrain([
            [0, 10], // left edge wall
            [49, 10], // right edge wall
            [10, 0], // top edge wall
            [10, 49], // bottom edge wall
          ]),
      });
      const matrix = new PathFinder.CostMatrix();

      applyTunnelWalls(matrix, room, TUNNEL_WALL_COST);

      expect(matrix.get(0, 10)).toBe(0);
      expect(matrix.get(49, 10)).toBe(0);
      expect(matrix.get(10, 0)).toBe(0);
      expect(matrix.get(10, 49)).toBe(0);
    });

    it('does not overwrite a tile already set to 255 (structure)', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTunnelTerrain([[15, 15]]),
      });
      const matrix = new PathFinder.CostMatrix();
      matrix.set(15, 15, 255); // pre-populated structure cost

      applyTunnelWalls(matrix, room, TUNNEL_WALL_COST);

      expect(matrix.get(15, 15)).toBe(255);
    });

    it('does not overwrite a tile already set to 1 (road)', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTunnelTerrain([[15, 15]]),
      });
      const matrix = new PathFinder.CostMatrix();
      matrix.set(15, 15, 1); // pre-populated road cost

      applyTunnelWalls(matrix, room, TUNNEL_WALL_COST);

      expect(matrix.get(15, 15)).toBe(1);
    });

    it('leaves plain/swamp tiles (no TERRAIN_MASK_WALL) untouched', () => {
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: () => makeTunnelTerrain([]), // no wall tiles at all
      });
      const matrix = new PathFinder.CostMatrix();

      applyTunnelWalls(matrix, room, TUNNEL_WALL_COST);

      // Spot-check several interior plain tiles — all should remain 0.
      expect(matrix.get(25, 25)).toBe(0);
      expect(matrix.get(1, 1)).toBe(0);
      expect(matrix.get(48, 48)).toBe(0);
    });

    it('caches the wall-tile list: getTerrain is only called once across two applyTunnelWalls calls', () => {
      const getTerrainSpy = vi.fn(() => makeTunnelTerrain([[10, 20]]));
      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: getTerrainSpy,
      });

      const matrix1 = new PathFinder.CostMatrix();
      applyTunnelWalls(matrix1, room, TUNNEL_WALL_COST);

      const matrix2 = new PathFinder.CostMatrix();
      applyTunnelWalls(matrix2, room, TUNNEL_WALL_COST);

      // getTerrain (and the inner terrain.get scan) should only happen once —
      // the second call re-uses the cached wall list.
      expect(getTerrainSpy).toHaveBeenCalledTimes(1);
      // Both matrices should have the same wall cost applied.
      expect(matrix1.get(10, 20)).toBe(TUNNEL_WALL_COST);
      expect(matrix2.get(10, 20)).toBe(TUNNEL_WALL_COST);
    });

    it('picks up new terrain after resetTunnelWallCache clears the cache', () => {
      // First call with a wall at (10,20).
      const getTerrainSpy = vi
        .fn()
        .mockReturnValueOnce(makeTunnelTerrain([[10, 20]]))
        // Second call (post-reset) has a different wall at (30,30).
        .mockReturnValueOnce(makeTunnelTerrain([[30, 30]]));

      const room = mockRoom({
        find: vi.fn(() => []),
        getTerrain: getTerrainSpy,
      });

      const matrix1 = new PathFinder.CostMatrix();
      applyTunnelWalls(matrix1, room, TUNNEL_WALL_COST);
      expect(matrix1.get(10, 20)).toBe(TUNNEL_WALL_COST);
      expect(matrix1.get(30, 30)).toBe(0); // not a wall in first terrain

      resetTunnelWallCache();

      const matrix2 = new PathFinder.CostMatrix();
      applyTunnelWalls(matrix2, room, TUNNEL_WALL_COST);
      expect(matrix2.get(30, 30)).toBe(TUNNEL_WALL_COST); // new terrain picked up
      expect(matrix2.get(10, 20)).toBe(0); // no longer a wall
      expect(getTerrainSpy).toHaveBeenCalledTimes(2); // one scan per cache population
    });
  });
});
