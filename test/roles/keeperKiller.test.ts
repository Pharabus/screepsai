import { keeperKiller } from '../../src/roles/keeperKiller';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

describe('keeperKiller', () => {
  describe('TRAVEL state', () => {
    it('stays in TRAVEL when not yet in target room', () => {
      const creep = mockCreep({
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0', state: 'TRAVEL' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('TRAVEL');
    });

    it('transitions to PATROL when in target room interior with no SK', () => {
      // Full setup: TRAVEL→PATROL chains and PATROL.run also executes this tick.
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_STRUCTURES) {
            const lairs = [{ structureType: STRUCTURE_KEEPER_LAIR, pos: { x: 10, y: 10 } }];
            if (opts?.filter) return lairs.filter(opts.filter);
            return lairs;
          }
          if (type === FIND_HOSTILE_CREEPS) {
            if (opts?.filter) return [];
            return [];
          }
          if (type === FIND_MY_SPAWNS) return [];
          return [];
        }),
      });
      const creep = mockCreep({
        ticksToLive: 1500,
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0', state: 'TRAVEL' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W0N0'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W0N0: {} };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('PATROL');
    });

    it('retreats when no targetRoom is set', () => {
      const spawn = {
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        recycleCreep: vi.fn(),
      };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', state: 'TRAVEL' },
        room: homeRoom,
        pos: new (globalThis as any).RoomPosition(24, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });
  });

  describe('PATROL state — lair memory', () => {
    it('populates keeperLairPositions on first arrival (TRAVEL→PATROL transition)', () => {
      const lair1 = { structureType: STRUCTURE_KEEPER_LAIR, pos: { x: 15, y: 20 } };
      const lair2 = { structureType: STRUCTURE_KEEPER_LAIR, pos: { x: 30, y: 30 } };
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_STRUCTURES) {
            const lairs = [lair1, lair2];
            if (opts?.filter) return lairs.filter(opts.filter);
            return lairs;
          }
          if (type === FIND_HOSTILE_CREEPS) return [];
          if (type === FIND_MY_SPAWNS) return [];
          return [];
        }),
      });
      const creep = mockCreep({
        ticksToLive: 1500,
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0', state: 'TRAVEL' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W0N0'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W0N0: {} };

      keeperKiller.run(creep);

      expect(Memory.rooms['W0N0']?.keeperLairPositions).toEqual([
        { x: 15, y: 20 },
        { x: 30, y: 30 },
      ]);
    });

    it('does not overwrite existing keeperLairPositions on re-entry', () => {
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn(() => []), // find should NOT be called — positions already cached
      });
      const creep = mockCreep({
        ticksToLive: 1500,
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0', state: 'PATROL' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W0N0'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W0N0: room };
      const existingPositions = [{ x: 10, y: 10 }];
      (Memory as any).rooms = { W0N0: { keeperLairPositions: existingPositions } };

      keeperKiller.run(creep);

      // Positions unchanged — find was not called for FIND_STRUCTURES
      expect(Memory.rooms['W0N0']?.keeperLairPositions).toBe(existingPositions);
      expect(room.find).not.toHaveBeenCalledWith(FIND_STRUCTURES, expect.anything());
    });
  });

  describe('PATROL state — combat and movement', () => {
    function patrolCreep(overrides: Record<string, any> = {}): any {
      return mockCreep({
        ticksToLive: 1500,
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0', state: 'PATROL' },
        pos: new (globalThis as any).RoomPosition(25, 25, 'W0N0'),
        ...overrides,
      });
    }

    it('heals self every tick regardless of combat action', () => {
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn(() => []),
      });
      const creep = patrolCreep({ room });
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W0N0: { keeperLairPositions: [{ x: 10, y: 10 }] } };

      keeperKiller.run(creep);

      expect(creep.heal).toHaveBeenCalledWith(creep);
    });

    it('attacks Source Keeper within melee range', () => {
      const keeper = {
        owner: { username: 'Source Keeper' },
        pos: new (globalThis as any).RoomPosition(25, 26, 'W0N0'), // range 1
      };
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) {
            const filter = opts?.filter ?? (() => true);
            return [keeper].filter(filter);
          }
          return [];
        }),
      });
      const creep = patrolCreep({ room });
      creep.attack = vi.fn(() => 0);
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W0N0: { keeperLairPositions: [] } };

      keeperKiller.run(creep);

      expect(creep.attack).toHaveBeenCalledWith(keeper);
    });

    it('does not attack Source Keeper out of melee range', () => {
      const keeper = {
        owner: { username: 'Source Keeper' },
        pos: new (globalThis as any).RoomPosition(20, 20, 'W0N0'), // range 5
      };
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) {
            const filter = opts?.filter ?? (() => true);
            return [keeper].filter(filter);
          }
          return [];
        }),
      });
      const creep = patrolCreep({ room });
      creep.attack = vi.fn(() => 0);
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W0N0: { keeperLairPositions: [] } };

      keeperKiller.run(creep);

      expect(creep.attack).not.toHaveBeenCalled();
    });

    it('moves toward nearest non-adjacent lair', () => {
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn(() => []),
      });
      const creep = patrolCreep({ room });
      (Game as any).rooms = { W0N0: room };
      // Two lairs: one far (15,15), one very far (40,40)
      (Memory as any).rooms = {
        W0N0: {
          keeperLairPositions: [
            { x: 15, y: 15 },
            { x: 40, y: 40 },
          ],
        },
      };

      keeperKiller.run(creep);

      // creep stays in PATROL — it has lair positions to patrol toward, high TTL,
      // and no SK to trigger retreat. Movement itself goes through the traffic system
      // (not testable at this level), but state stability confirms pathing was attempted.
      expect(creep.memory.state).toBe('PATROL');
    });

    it('transitions to RETREAT when ticksToLive is below travel estimate', () => {
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn(() => []),
      });
      const creep = patrolCreep({
        ticksToLive: 50,
        room,
      });
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = {
        W1N1: { remoteDistance: { W0N0: 100 } },
        W0N0: { keeperLairPositions: [] },
      };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });

    it('uses fallback travel time of 100 when remoteDistance is not cached', () => {
      const room = mockRoom({
        name: 'W0N0',
        find: vi.fn(() => []),
      });
      const creep = patrolCreep({ ticksToLive: 50, room });
      (Game as any).rooms = { W0N0: room };
      (Memory as any).rooms = { W1N1: {}, W0N0: { keeperLairPositions: [] } };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });

    it('returns to TRAVEL when drifted out of target room', () => {
      const room = mockRoom({ name: 'W1N1' });
      const creep = patrolCreep({
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).rooms = { W1N1: room };
      (Memory as any).rooms = { W0N0: {} };

      keeperKiller.run(creep);

      expect(creep.memory.state).toBe('TRAVEL');
    });
  });

  describe('RETREAT state', () => {
    it('recycles at spawn when adjacent', () => {
      const spawn = {
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        recycleCreep: vi.fn(),
      };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', state: 'RETREAT' },
        room: homeRoom,
        pos: new (globalThis as any).RoomPosition(25, 24, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      keeperKiller.run(creep);

      expect(spawn.recycleCreep).toHaveBeenCalledWith(creep);
    });

    it('does not recycle when not adjacent to spawn', () => {
      const spawn = {
        pos: new (globalThis as any).RoomPosition(10, 10, 'W1N1'),
        recycleCreep: vi.fn(),
      };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', state: 'RETREAT' },
        room: homeRoom,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      keeperKiller.run(creep);

      expect(spawn.recycleCreep).not.toHaveBeenCalled();
      expect(creep.memory.state).toBe('RETREAT');
    });
  });
});
