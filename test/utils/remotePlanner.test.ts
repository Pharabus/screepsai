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

    it('treats missing storage as 0 (cap stays at 1)', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W1N2' }) as any;
      Memory.rooms['W2N1'] = { scoutedAt: 100, scoutedSources: 2 } as any;
      Memory.rooms['W1N2'] = { scoutedAt: 100, scoutedSources: 2 } as any;

      const room = mockRoom({ name: 'W1N1' }); // no storage
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

    it('classifies rooms with a controller as reserved', () => {
      Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;

      const room = mockRoom({ name: 'W1N1' });
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

      const room = mockRoom({ name: 'W1N1' });
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
});
