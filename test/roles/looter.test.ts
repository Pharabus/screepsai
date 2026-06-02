/**
 * Tests for the looter role and resolveLootTarget helper.
 */
import '../mocks/screeps';
import { looter, resolveLootTarget } from '../../src/roles/looter';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

// ---------------------------------------------------------------------------
// resolveLootTarget
// ---------------------------------------------------------------------------

describe('resolveLootTarget', () => {
  it('returns null when no lootTargetId in memory', () => {
    (Memory as any).rooms = { W1N1: {} };
    expect(resolveLootTarget('W1N1')).toBeNull();
  });

  it('returns null when room memory does not exist', () => {
    (Memory as any).rooms = {};
    expect(resolveLootTarget('W1N1')).toBeNull();
  });

  it('returns the structure when lootTargetId resolves to a non-empty store', () => {
    const fakeStorage = { id: 'storage1', store: { getUsedCapacity: () => 607_371 } };
    (Memory as any).rooms = { W1N1: { lootTargetId: 'storage1' } };
    (Game as any).getObjectById = (id: string) => (id === 'storage1' ? fakeStorage : null);

    const result = resolveLootTarget('W1N1');
    expect(result).toBe(fakeStorage);
    // Memory should still have lootTargetId set
    expect((Memory.rooms as any).W1N1.lootTargetId).toBe('storage1');
  });

  it('clears lootTargetId and returns null when structure is gone', () => {
    (Memory as any).rooms = { W1N1: { lootTargetId: 'gone1' } };
    (Game as any).getObjectById = () => null;

    const result = resolveLootTarget('W1N1');
    expect(result).toBeNull();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });

  it('clears lootTargetId and returns null when structure store is empty', () => {
    const emptyStorage = { id: 'storage2', store: { getUsedCapacity: () => 0 } };
    (Memory as any).rooms = { W1N1: { lootTargetId: 'storage2' } };
    (Game as any).getObjectById = (id: string) => (id === 'storage2' ? emptyStorage : null);

    const result = resolveLootTarget('W1N1');
    expect(result).toBeNull();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// looter role — state machine
// ---------------------------------------------------------------------------

describe('looter role', () => {
  describe('TRAVEL state', () => {
    it('stays in TRAVEL when not yet in homeRoom interior', () => {
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'TRAVEL' },
        room: mockRoom({ name: 'W2N2' }),
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N2'),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Memory as any).rooms = { W1N1: {} };

      looter.run(creep);

      expect(creep.memory.state).toBe('TRAVEL');
    });

    it('transitions to DISMANTLE when in homeRoom interior with loot target', () => {
      const fakeStorage = {
        id: 'storage1',
        store: { getUsedCapacity: () => 100_000 },
        pos: new (globalThis as any).RoomPosition(20, 20, 'W1N1'),
      };
      (Memory as any).rooms = { W1N1: { lootTargetId: 'storage1' } };
      (Game as any).getObjectById = (id: string) => (id === 'storage1' ? fakeStorage : null);

      const room = mockRoom({ name: 'W1N1' });
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'TRAVEL' },
        room,
        // Interior position: ≥3 tiles from every border
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        dismantle: vi.fn(() => OK),
      });
      (Game as any).creeps = { [creep.name]: creep };
      (Game as any).rooms = { W1N1: room };

      looter.run(creep);

      // After TRAVEL→DISMANTLE chain, the role calls dismantle on the target
      expect(creep.dismantle).toHaveBeenCalledWith(fakeStorage);
      expect(creep.memory.state).toBe('DISMANTLE');
    });
  });

  describe('DISMANTLE state', () => {
    it('calls dismantle on the loot target when in range', () => {
      const fakeStorage = {
        id: 'storage1',
        store: { getUsedCapacity: () => 10_000 },
        pos: new (globalThis as any).RoomPosition(26, 25, 'W1N1'),
      };
      (Memory as any).rooms = { W1N1: { lootTargetId: 'storage1' } };
      (Game as any).getObjectById = (id: string) => (id === 'storage1' ? fakeStorage : null);

      const room = mockRoom({ name: 'W1N1' });
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'DISMANTLE' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        dismantle: vi.fn(() => OK),
      });
      (Game as any).creeps = { [creep.name]: creep };

      looter.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(fakeStorage);
    });

    it('moves toward loot target when not in range', () => {
      const fakeStorage = {
        id: 'storage1',
        store: { getUsedCapacity: () => 10_000 },
        pos: new (globalThis as any).RoomPosition(40, 40, 'W1N1'),
      };
      (Memory as any).rooms = { W1N1: { lootTargetId: 'storage1' } };
      (Game as any).getObjectById = (id: string) => (id === 'storage1' ? fakeStorage : null);

      const room = mockRoom({ name: 'W1N1' });
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'DISMANTLE' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        dismantle: vi.fn(() => ERR_NOT_IN_RANGE),
      });
      (Game as any).creeps = { [creep.name]: creep };

      looter.run(creep);

      // dismantle returns ERR_NOT_IN_RANGE so creep.move will have been queued
      expect(creep.dismantle).toHaveBeenCalledWith(fakeStorage);
    });

    it('idles (no dismantle) when no loot target exists', () => {
      (Memory as any).rooms = { W1N1: {} };
      (Game as any).getObjectById = () => null;

      const room = mockRoom({ name: 'W1N1' });
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'DISMANTLE' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        dismantle: vi.fn(() => OK),
      });
      (Game as any).creeps = { [creep.name]: creep };

      looter.run(creep);

      expect(creep.dismantle).not.toHaveBeenCalled();
    });

    it('returns to TRAVEL when pushed back across the border', () => {
      const room = mockRoom({ name: 'W2N2' }); // wrong room
      const creep = mockCreep({
        name: 'looter_W1N1_1',
        memory: { role: 'looter', homeRoom: 'W1N1', state: 'DISMANTLE' },
        room,
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N2'),
        dismantle: vi.fn(() => OK),
      });
      (Memory as any).rooms = { W1N1: { lootTargetId: 'storage1' } };
      (Game as any).creeps = { [creep.name]: creep };

      looter.run(creep);

      expect(creep.memory.state).toBe('TRAVEL');
      expect(creep.dismantle).not.toHaveBeenCalled();
    });
  });
});
