import { hunter } from '../../src/roles/hunter';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

describe('hunter', () => {
  describe('TRAVEL state', () => {
    it('stays in TRAVEL when not in target room yet', () => {
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'TRAVEL' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };

      hunter.run(creep);

      expect(creep.memory.state).toBe('TRAVEL');
    });

    it('transitions to HUNT and stays when in target room interior with invaders', () => {
      // State machine chains: TRAVEL→HUNT in the same tick. Provide an invader
      // so HUNT doesn't immediately chain to RETREAT.
      const invader = {
        hits: 100,
        hitsMax: 200,
        owner: { username: 'Invader' },
        pos: new (globalThis as any).RoomPosition(20, 20, 'W2N1'),
      };
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) {
            const filter = opts?.filter ?? (() => true);
            return [invader].filter(filter);
          }
          return [];
        }),
      });
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'TRAVEL' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W2N1: room };
      (Memory as any).rooms = { W2N1: {} };

      hunter.run(creep);

      expect(creep.memory.state).toBe('HUNT');
    });

    it('retreats when no targetRoom set', () => {
      const spawn = {
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        recycleCreep: vi.fn(),
      };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', state: 'TRAVEL' },
        room: homeRoom,
        pos: new (globalThis as any).RoomPosition(24, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      hunter.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });
  });

  describe('HUNT state', () => {
    it('attacks lowest-HP invader and sets invaderSeenAt', () => {
      const invader = {
        hits: 100,
        hitsMax: 200,
        owner: { username: 'Invader' },
        pos: new (globalThis as any).RoomPosition(20, 20, 'W2N1'),
      };
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) {
            const filter = opts?.filter ?? (() => true);
            return [invader].filter(filter);
          }
          return [];
        }),
      });
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'HUNT' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W2N1: room };
      (Game as any).time = 500;
      (Memory as any).rooms = { W2N1: {} };

      creep.attack = vi.fn(() => OK);
      hunter.run(creep);

      expect(creep.attack).toHaveBeenCalledWith(invader);
      expect(Memory.rooms['W2N1']!.invaderSeenAt).toBe(500);
    });

    it('heals self when damaged, regardless of combat action', () => {
      const invader = {
        hits: 100,
        hitsMax: 200,
        owner: { username: 'Invader' },
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
      };
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) {
            const filter = opts?.filter ?? (() => true);
            return [invader].filter(filter);
          }
          return [];
        }),
      });
      const creep = mockCreep({
        hits: 80,
        hitsMax: 200,
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'HUNT' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W2N1: room };
      (Memory as any).rooms = { W2N1: {} };

      creep.attack = vi.fn(() => OK);
      hunter.run(creep);

      expect(creep.heal).toHaveBeenCalledWith(creep);
    });

    it('transitions to RETREAT and clears invaderSeenAt when room is empty', () => {
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn((type: number, _opts?: any) => {
          if (type === FIND_HOSTILE_CREEPS) return [];
          if (type === FIND_MY_SPAWNS) return [];
          return [];
        }),
      });
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'HUNT' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W2N1: room };
      (Memory as any).rooms = { W2N1: { invaderSeenAt: 400 } };

      hunter.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
      expect(Memory.rooms['W2N1']!.invaderSeenAt).toBeUndefined();
    });

    it('returns to TRAVEL when drifted out of target room', () => {
      const room = mockRoom({ name: 'W1N1' });
      const creep = mockCreep({
        memory: { role: 'hunter', homeRoom: 'W1N1', targetRoom: 'W2N1', state: 'HUNT' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Memory as any).rooms = {};

      hunter.run(creep);

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
        memory: { role: 'hunter', homeRoom: 'W1N1', state: 'RETREAT' },
        room: homeRoom,
        // Adjacent to spawn (range 1)
        pos: new (globalThis as any).RoomPosition(25, 24, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      hunter.run(creep);

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
        memory: { role: 'hunter', homeRoom: 'W1N1', state: 'RETREAT' },
        room: homeRoom,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: homeRoom };

      hunter.run(creep);

      // recycleCreep must not fire when out of range; state stays RETREAT
      expect(spawn.recycleCreep).not.toHaveBeenCalled();
      expect(creep.memory.state).toBe('RETREAT');
    });
  });
});
