import { resetGameGlobals, mockRoom, mockCreep } from '../mocks/screeps';
import { evaluateRemoteRoom, selectRemoteRooms } from '../../src/utils/remotePlanner';
import { recordHostile } from '../../src/utils/neighbors';
import { flushSegments } from '../../src/utils/segments';

function mockStorage(stored: number): any {
  return { store: { getUsedCapacity: () => stored } };
}

describe('remotePlanner', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  describe('evaluateRemoteRoom', () => {
    it('returns -1 for rooms with no scouted data', () => {
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('returns -1 for rooms scouted but missing scoutedAt', () => {
      Memory.rooms['W2N1'] = { scoutedSources: 2 } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('returns -1 for owned rooms', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedOwner: 'SomePlayer',
        scoutedSources: 2,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('returns -1 for rooms reserved by other players', () => {
      Game.spawns = { Spawn1: { owner: { username: 'Me' } } } as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedReservation: 'SomePlayer',
        scoutedSources: 1,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('accepts rooms reserved by own player', () => {
      Game.spawns = { Spawn1: { owner: { username: 'Me' } } } as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedReservation: 'Me',
        scoutedSources: 2,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(2);
    });

    it('returns -1 for rooms with recent hostiles', () => {
      Game.time = 2000;
      Memory.rooms['W2N1'] = {
        scoutedAt: 1000,
        scoutedHostiles: 3,
        scoutedSources: 2,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('tolerates stale hostile sightings (>1500 ticks old)', () => {
      Game.time = 3000;
      Memory.rooms['W2N1'] = {
        scoutedAt: 1000,
        scoutedHostiles: 3,
        scoutedSources: 2,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(2);
    });

    it('returns -1 for rooms with zero sources', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 0,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('returns source count as score for valid rooms', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 1,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(1);

      Memory.rooms['W2N2'] = {
        scoutedAt: 100,
        scoutedSources: 2,
      } as any;
      expect(evaluateRemoteRoom('W2N2')).toBe(2);
    });

    it('treats missing scoutedHostiles as zero', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 1,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(1);
    });

    it('rejects rooms where an aggressive neighbor has been seen recently', () => {
      // Record 3 attacks from same player in W9N9 so they classify as aggressive.
      // Use a unique room name to avoid polluting the segment cache for other tests
      // (resetGameGlobals keeps Game.time=0 so resetIfNewTick never clears the cache).
      const attacker = mockCreep({
        owner: { username: 'Griefer' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      const targetRoom = mockRoom({ name: 'W9N9' });
      for (let i = 0; i < 3; i++) {
        recordHostile(attacker, targetRoom);
        flushSegments();
      }
      Memory.rooms['W9N9'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      expect(evaluateRemoteRoom('W9N9')).toBe(-1);
    });

    it('accepts rooms where only passive hostiles have been seen', () => {
      // A scout (no threat-score body parts) stays passive
      const scout = mockCreep({
        owner: { username: 'PassiveScout' },
        body: [{ type: MOVE, hits: 100 }],
      });
      const targetRoom = mockRoom({ name: 'W9N8' });
      recordHostile(scout, targetRoom);
      Memory.rooms['W9N8'] = { scoutedAt: 100, scoutedSources: 1 } as any;
      expect(evaluateRemoteRoom('W9N8')).toBe(1);
    });

    it('rejects SK room when allowKeeperRooms is false (default)', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      expect(evaluateRemoteRoom('W2N1')).toBe(-1);
    });

    it('rejects SK room even when allowKeeperRooms is true if no killer is alive', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      Game.creeps = {} as any; // no killers
      expect(evaluateRemoteRoom('W2N1', true)).toBe(-1);
    });

    it('accepts SK room when allowKeeperRooms is true and a killer is alive', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      (Game as any).creeps = {
        kk1: { memory: { role: 'keeperKiller', targetRoom: 'W2N1', homeRoom: 'W1N1' } },
      };
      expect(evaluateRemoteRoom('W2N1', true)).toBe(9); // 3 sources × 3
    });
  });

  describe('selectRemoteRooms', () => {
    it('does nothing when describeExits returns null', () => {
      Game.map.describeExits = () => null as any;
      const room = mockRoom({ name: 'W1N1' });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);
      expect(Memory.rooms['W1N1'].remoteRooms).toBeUndefined();
    });

    it('picks the best room sorted by score', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2', '5': 'W0N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W0N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      const result = Memory.rooms['W1N1'].remoteRooms!;
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('W1N2');
    });

    it('limits to 1 remote room when storage is below 100k', () => {
      Game.map.describeExits = () =>
        ({ '1': 'W2N1', '3': 'W1N2', '5': 'W0N1', '7': 'W1N0' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W0N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N0'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(99_999) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(1);
    });

    it('scales to 2 remote rooms once storage reaches 100k', () => {
      Game.map.describeExits = () =>
        ({ '1': 'W2N1', '3': 'W1N2', '5': 'W0N1', '7': 'W1N0' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W0N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N0'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(100_000) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(2);
    });

    it('treats empty storage as 0 energy (cap stays at 1)', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(1);
    });

    it('sets empty array when no valid rooms exist', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedOwner: 'Enemy' } as any;
      Memory.rooms['W1N2'] = {} as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteRooms).toEqual([]);
    });

    it('excludes rooms with negative scores', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedOwner: 'Enemy', scoutedSources: 2 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteRooms).toEqual(['W2N1']);
    });

    it('initializes RoomMemory if missing', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1']).toBeDefined();
      expect(Memory.rooms['W1N1'].remoteRooms).toEqual(['W2N1']);
    });

    it('classifies SK rooms as keeperRoom', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      // Provide an alive killer so evaluateRemoteRoom accepts the room
      (Game as any).creeps = {
        kk1: { memory: { role: 'keeperKiller', targetRoom: 'W2N1', homeRoom: 'W1N1' } },
      };

      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        energyCapacityAvailable: 5300,
      });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].remoteType).toBe('keeperRoom');
    });

    it('sets flee policy for keeper rooms', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      (Game as any).creeps = {
        kk1: { memory: { role: 'keeperKiller', targetRoom: 'W2N1', homeRoom: 'W1N1' } },
      };

      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        energyCapacityAvailable: 5300,
      });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].defensePolicy).toBe('flee');
    });

    it('does not opt in SK rooms when energyCapacityAvailable < 5300', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 3,
        scoutedHasKeepers: true,
      } as any;
      (Game as any).creeps = {
        kk1: { memory: { role: 'keeperKiller', targetRoom: 'W2N1', homeRoom: 'W1N1' } },
      };

      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        energyCapacityAvailable: 5299,
      });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      // SK room rejected — remoteRooms should be empty
      expect(Memory.rooms['W1N1'].remoteRooms).toEqual([]);
    });

    it('classifies rooms with a controller as reserved', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].remoteType).toBe('reserved');
    });

    it('classifies rooms without a controller as remote', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: false,
      } as any;

      const room = mockRoom({ name: 'W1N1', storage: mockStorage(0) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].remoteType).toBe('remote');
    });

    it('sets defend policy for reserved rooms and flee for remote rooms', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      Memory.rooms['W1N2'] = {
        scoutedAt: 100,
        scoutedSources: 1,
        scoutedHasController: false,
      } as any;

      // Storage ≥ 100k so cap = 2 and both rooms get selected
      const room = mockRoom({ name: 'W1N1', storage: mockStorage(100_000) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].defensePolicy).toBe('defend');
      expect(Memory.rooms['W1N2'].defensePolicy).toBe('flee');
    });

    it('does not overwrite an existing defense policy', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 1,
        scoutedHasController: false,
        defensePolicy: 'abandon',
      } as any;

      const room = mockRoom({ name: 'W1N1' });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);

      expect(Memory.rooms['W2N1'].defensePolicy).toBe('abandon');
    });

    it('keeps 2 remotes with hysteresis when storage is between 70k-100k', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2', '5': 'W0N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W0N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      // First call at 100k — opens cap to 2
      const room = mockRoom({ name: 'W1N1', storage: mockStorage(100_000) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);
      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(2);

      // Storage drops to 80k (between 70k and 100k) — hysteresis keeps cap at 2
      (room.storage as any).store.getUsedCapacity = () => 80_000;
      selectRemoteRooms(room);
      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(2);
    });

    it('drops to 1 remote when storage falls below 70k scale-down threshold', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      // First call at 100k — opens cap to 2
      const room = mockRoom({ name: 'W1N1', storage: mockStorage(100_000) });
      Memory.rooms['W1N1'] = {};
      selectRemoteRooms(room);
      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(2);

      // Storage drops below 70k — cap drops back to 1
      (room.storage as any).store.getUsedCapacity = () => 69_999;
      selectRemoteRooms(room);
      expect(Memory.rooms['W1N1'].remoteRooms).toHaveLength(1);
    });
  });

  describe('remoteDistance caching', () => {
    it('populates remoteDistance and remoteDistanceUpdated after selectRemoteRooms', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 1,
        scoutedSourceData: [{ id: 'src1' as any, x: 20, y: 30 }],
      } as any;

      const mockSpawn = { pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') };
      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        find: vi.fn((type: number) => {
          if (type === FIND_MY_SPAWNS) return [mockSpawn];
          return [];
        }),
      });
      Memory.rooms['W1N1'] = {};

      const origSearch = (globalThis as any).PathFinder.search;
      (globalThis as any).PathFinder.search = vi.fn(() => ({
        path: Array(30).fill({}),
        ops: 0,
        cost: 0,
        incomplete: false,
      }));

      selectRemoteRooms(room);
      (globalThis as any).PathFinder.search = origSearch;

      // roundTripTicks = 30 × 4 = 120
      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBe(120);
      expect(Memory.rooms['W1N1'].remoteDistanceUpdated!['W2N1']).toBe(Game.time);
    });

    it('does not recompute a fresh entry (remoteDistanceUpdated within 5000 ticks)', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const mockSpawn = { pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') };
      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [mockSpawn] : [])),
      });
      // updatedAt = Game.time (1) → delta = 0 → not stale
      Memory.rooms['W1N1'] = {
        remoteDistance: { W2N1: 999 },
        remoteDistanceUpdated: { W2N1: (Game as any).time },
      } as any;

      const searchSpy = vi.fn(() => ({
        path: Array(30).fill({}),
        ops: 0,
        cost: 0,
        incomplete: false,
      }));
      const origSearch = (globalThis as any).PathFinder.search;
      (globalThis as any).PathFinder.search = searchSpy;

      selectRemoteRooms(room);
      (globalThis as any).PathFinder.search = origSearch;

      expect(searchSpy).not.toHaveBeenCalled();
      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBe(999);
    });

    it('recomputes when entry is stale (>5000 ticks since last update)', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const mockSpawn = { pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') };
      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [mockSpawn] : [])),
      });
      // updatedAt = 0, Game.time = 5002 → delta = 5002 > 5000 → stale
      (Game as any).time = 5002;
      Memory.rooms['W1N1'] = {
        remoteDistance: { W2N1: 999 },
        remoteDistanceUpdated: { W2N1: 0 },
      } as any;

      const searchSpy = vi.fn(() => ({
        path: Array(25).fill({}),
        ops: 0,
        cost: 0,
        incomplete: false,
      }));
      const origSearch = (globalThis as any).PathFinder.search;
      (globalThis as any).PathFinder.search = searchSpy;

      selectRemoteRooms(room);
      (globalThis as any).PathFinder.search = origSearch;

      expect(searchSpy).toHaveBeenCalled();
      // 25 × 4 = 100, old value 999 replaced
      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBe(100);
      expect(Memory.rooms['W1N1'].remoteDistanceUpdated!['W2N1']).toBe(5002);
    });

    it('evicts remoteDistance and remoteDistanceUpdated for deselected rooms', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const mockSpawn = { pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') };
      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(100_000),
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [mockSpawn] : [])),
      });
      // Both fresh so no recomputation
      Memory.rooms['W1N1'] = {
        remoteDistance: { W2N1: 200, W1N2: 160 },
        remoteDistanceUpdated: { W2N1: (Game as any).time, W1N2: (Game as any).time },
      } as any;

      // Drop storage so only W2N1 (score 2) is selected
      (room.storage as any).store.getUsedCapacity = () => 50_000;
      selectRemoteRooms(room);

      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBe(200);
      expect(Memory.rooms['W1N1'].remoteDistance!['W1N2']).toBeUndefined();
      expect(Memory.rooms['W1N1'].remoteDistanceUpdated!['W1N2']).toBeUndefined();
    });

    it('uses center position (25,25) when no scoutedSourceData is available', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any; // no scoutedSourceData

      const mockSpawn = { pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1') };
      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [mockSpawn] : [])),
      });
      Memory.rooms['W1N1'] = {};

      const searchSpy = vi.fn(() => ({
        path: Array(20).fill({}),
        ops: 0,
        cost: 0,
        incomplete: false,
      }));
      const origSearch = (globalThis as any).PathFinder.search;
      (globalThis as any).PathFinder.search = searchSpy;

      selectRemoteRooms(room);

      (globalThis as any).PathFinder.search = origSearch;

      expect(searchSpy).toHaveBeenCalled();
      // The goal pos should be (25,25) in W2N1
      const callArgs = searchSpy.mock.calls[0];
      expect(callArgs[1].pos.x).toBe(25);
      expect(callArgs[1].pos.y).toBe(25);
      expect(callArgs[1].pos.roomName).toBe('W2N1');
      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBe(80); // 20 × 4
    });

    it('skips distance computation when no spawn is present', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 1 } as any;

      const room = mockRoom({
        name: 'W1N1',
        storage: mockStorage(0),
        find: vi.fn(() => []), // no spawns
      });
      Memory.rooms['W1N1'] = {};

      selectRemoteRooms(room);

      // remoteDistance should be initialised but empty (no spawn = no PathFinder call)
      expect(Memory.rooms['W1N1'].remoteDistance).toBeDefined();
      expect(Memory.rooms['W1N1'].remoteDistance!['W2N1']).toBeUndefined();
    });
  });
});
