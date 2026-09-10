import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { powerHauler } from '../../src/roles/powerHauler';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
  isInRoomInterior: vi.fn(() => true),
}));

import { moveTo, isInRoomInterior } from '../../src/utils/movement';

/** Store mock whose Object.keys() yields only resource keys, not methods —
 * matches the real engine's Store, unlike a plain object literal. */
function mockStore(contents: Record<string, number> = {}, capacity = 1000): any {
  const store: Record<string, any> = {};
  for (const [key, val] of Object.entries(contents)) {
    if (val > 0) store[key] = val;
  }
  Object.defineProperty(store, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r === undefined) return Object.values(contents).reduce((a, b) => a + b, 0);
      return contents[r] ?? 0;
    }),
  });
  Object.defineProperty(store, 'getFreeCapacity', {
    enumerable: false,
    value: vi.fn(() => {
      const total = Object.values(contents).reduce((a, b) => a + b, 0);
      return Math.max(0, capacity - total);
    }),
  });
  return store;
}

function setTarget(homeRoom: string, overrides: Record<string, any> = {}): void {
  Memory.rooms[homeRoom] = {
    powerBankTarget: {
      room: 'W2N1',
      x: 20,
      y: 20,
      id: 'bank1' as Id<StructurePowerBank>,
      power: 2000,
      attackersNeeded: 2,
      haulersNeeded: 2,
      assignedAtTick: 1,
      ...overrides,
    },
  } as any;
}

function mockDrop(overrides: Record<string, any> = {}): any {
  return {
    id: 'drop1',
    resourceType: 'power',
    amount: 2000,
    pos: new RoomPosition(20, 20, 'W2N1'),
    ...overrides,
  };
}

describe('powerHauler', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
    (isInRoomInterior as any).mockReturnValue(true);
    (Memory as any).rooms = {};
  });

  describe('TRAVEL state', () => {
    it('marks idle when no target is set and the creep is empty', () => {
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      powerHauler.run(creep);

      expect(moveTo).not.toHaveBeenCalled();
      expect(creep.memory.idleSince).toBeDefined();
    });

    it('moves toward the bank room when not there yet', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      powerHauler.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ roomName: 'W2N1', x: 20, y: 20 }),
        expect.objectContaining({ priority: expect.any(Number) }),
      );
    });

    it('transitions to WAIT once interior', () => {
      setTarget('W1N1');
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'TRAVEL', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
      });
      Game.getObjectById = vi.fn(() => ({ id: 'bank1', hits: 2000000 })) as any;

      powerHauler.run(creep);

      expect(creep.memory.state).toBe('WAIT');
    });
  });

  describe('WAIT state', () => {
    it('stages near the bank while it is still alive and no drop exists', () => {
      setTarget('W1N1');
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      Game.getObjectById = vi.fn(() => ({ id: 'bank1', hits: 2000000 })) as any;
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'WAIT', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerHauler.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 20, y: 20 }),
        expect.objectContaining({ range: 3 }),
      );
      expect(Memory.rooms.W1N1.powerBankTarget).toBeDefined();
    });

    it('transitions to PICKUP once a power drop appears', () => {
      setTarget('W1N1');
      const drop = mockDrop();
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => [drop]) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'WAIT', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerHauler.run(creep);

      expect(creep.memory.state).toBe('PICKUP');
      expect(creep.pickup).toHaveBeenCalledWith(drop);
    });

    it('clears the target when the bank is destroyed and no drop is found (room visible)', () => {
      setTarget('W1N1');
      Game.getObjectById = vi.fn(() => undefined) as any;
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'WAIT', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: mockStore({}),
      });

      powerHauler.run(creep);

      expect(Memory.rooms.W1N1.powerBankTarget).toBeUndefined();
    });
  });

  describe('PICKUP state', () => {
    it('picks up the drop when in range', () => {
      setTarget('W1N1');
      const drop = mockDrop();
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => [drop]) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'PICKUP', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: mockStore({}),
      });

      powerHauler.run(creep);

      expect(creep.pickup).toHaveBeenCalledWith(drop);
    });

    it('moves toward the drop when out of range', () => {
      setTarget('W1N1');
      const drop = mockDrop();
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => [drop]) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'PICKUP', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(10, 10, 'W2N1'),
        store: mockStore({}),
      });

      powerHauler.run(creep);

      expect(creep.pickup).not.toHaveBeenCalled();
      expect(moveTo).toHaveBeenCalledWith(creep, drop, expect.objectContaining({ range: 1 }));
    });

    it('transitions to DELIVER once full', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'PICKUP', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1', storage: undefined, find: vi.fn(() => []) }),
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: { getUsedCapacity: () => 1250, getFreeCapacity: () => 0 },
      });

      powerHauler.run(creep);

      expect(creep.pickup).not.toHaveBeenCalled();
      expect(creep.memory.state).toBe('DELIVER');
    });

    it('clears the target once the drop is fully collected', () => {
      setTarget('W1N1');
      const room = mockRoom({ name: 'W2N1', find: vi.fn(() => []) });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'PICKUP', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: mockStore({ power: 500 }),
      });

      powerHauler.run(creep);

      expect(Memory.rooms.W1N1.powerBankTarget).toBeUndefined();
      // Still carrying power -> should fall through to DELIVER this same tick.
      expect(creep.memory.state).toBe('DELIVER');
    });
  });

  describe('DELIVER state', () => {
    it('transfers RESOURCE_POWER to home storage when in the home room', () => {
      const storage = { my: true, pos: new RoomPosition(16, 28, 'W1N1') };
      const room = mockRoom({ name: 'W1N1', storage });
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'DELIVER', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(16, 27, 'W1N1'),
        store: mockStore({ power: 1250 }),
        transfer: vi.fn(() => 0),
      });

      powerHauler.run(creep);

      expect(creep.transfer).toHaveBeenCalledWith(storage, 'power');
    });

    it('moves toward home storage when not yet in the home room', () => {
      setTarget('W1N1');
      const storage = { my: true, pos: new RoomPosition(16, 28, 'W1N1') };
      const homeRoom = mockRoom({ name: 'W1N1', storage });
      Game.rooms = { W1N1: homeRoom } as any;
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'DELIVER', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1', find: vi.fn(() => []) }),
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: mockStore({ power: 1250 }),
      });

      powerHauler.run(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, storage.pos, expect.any(Object));
    });

    it('returns to TRAVEL once empty if the target is still active (another wave)', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'phl1',
        memory: { role: 'powerHauler', state: 'DELIVER', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(16, 27, 'W1N1'),
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1250 },
      });

      powerHauler.run(creep);

      // State-chaining runs TRAVEL's handler too — it should try to path
      // back out toward the (still-set) power bank target.
      expect(moveTo).toHaveBeenCalled();
    });
  });
});
