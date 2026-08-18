import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { depositMiner } from '../../src/roles/depositMiner';

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
    depositTarget: {
      room: 'W2N1',
      x: 20,
      y: 20,
      depositType: 'silicon',
      id: 'dep1' as Id<Deposit>,
      ...overrides,
    },
  } as any;
}

function mockDeposit(overrides: Record<string, any> = {}): any {
  return {
    id: 'dep1',
    depositType: 'silicon',
    cooldown: 0,
    lastCooldown: 0,
    pos: new RoomPosition(20, 20, 'W2N1'),
    ...overrides,
  };
}

describe('depositMiner', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
    (isInRoomInterior as any).mockReturnValue(true);
    (Memory as any).rooms = {};
  });

  describe('TRAVEL state', () => {
    it('does nothing when no depositTarget is set and the creep is empty', () => {
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      depositMiner.run(creep);

      expect(moveTo).not.toHaveBeenCalled();
      expect(creep.harvest).not.toHaveBeenCalled();
      expect(creep.memory.state).toBe('TRAVEL');
    });

    it('moves toward the deposit room when not there yet', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      depositMiner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ roomName: 'W2N1', x: 20, y: 20 }),
        expect.objectContaining({ priority: expect.any(Number) }),
      );
    });

    it('steps toward the interior when on a border tile inside the target room', () => {
      setTarget('W1N1');
      (isInRoomInterior as any).mockReturnValue(false);
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(0, 25, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 25, y: 25 }),
        expect.objectContaining({ range: 20 }),
      );
    });

    it('transitions to HARVEST and harvests once interior and within range 1 of the deposit', () => {
      setTarget('W1N1');
      const deposit = mockDeposit();
      Game.getObjectById = vi.fn(() => deposit) as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      // State-chaining means HARVEST's handler also runs this same tick.
      expect(creep.memory.state).toBe('HARVEST');
      expect(creep.harvest).toHaveBeenCalledWith(deposit);
    });
  });

  describe('HARVEST state', () => {
    it('harvests when the deposit cooldown is 0', () => {
      setTarget('W1N1');
      const deposit = mockDeposit({ cooldown: 0 });
      Game.getObjectById = vi.fn(() => deposit) as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(creep.harvest).toHaveBeenCalledWith(deposit);
    });

    it('waits without harvesting while the deposit is on cooldown', () => {
      setTarget('W1N1');
      const deposit = mockDeposit({ cooldown: 5, lastCooldown: 5 });
      Game.getObjectById = vi.fn(() => deposit) as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(creep.harvest).not.toHaveBeenCalled();
      expect(Memory.rooms.W1N1.depositTarget).toBeDefined(); // not abandoned
    });

    it('transitions to DELIVER when full', () => {
      setTarget('W1N1');
      const deposit = mockDeposit();
      Game.getObjectById = vi.fn(() => deposit) as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1', storage: undefined }),
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: { getUsedCapacity: () => 500, getFreeCapacity: () => 0 },
      });

      depositMiner.run(creep);

      expect(creep.harvest).not.toHaveBeenCalled();
      expect(creep.memory.state).toBe('DELIVER');
    });

    it('abandons the target once lastCooldown exceeds the threshold', () => {
      setTarget('W1N1');
      const deposit = mockDeposit({ cooldown: 0, lastCooldown: 500 });
      Game.getObjectById = vi.fn(() => deposit) as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(creep.harvest).not.toHaveBeenCalled();
      expect(Memory.rooms.W1N1.depositTarget).toBeUndefined();
    });

    it('abandons the target when the deposit is gone and the room is visible', () => {
      setTarget('W1N1');
      Game.getObjectById = vi.fn(() => undefined) as any;
      const room = mockRoom({ name: 'W2N1' });
      Game.rooms = { W2N1: room } as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(Memory.rooms.W1N1.depositTarget).toBeUndefined();
    });

    it('does NOT abandon when the deposit lookup fails but the room is not visible (just dark, not gone)', () => {
      setTarget('W1N1');
      Game.getObjectById = vi.fn(() => undefined) as any;
      Game.rooms = {}; // target room not visible this tick
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'HARVEST', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      depositMiner.run(creep);

      expect(Memory.rooms.W1N1.depositTarget).toBeDefined();
    });
  });

  describe('DELIVER state', () => {
    it('transfers to home storage when in the home room', () => {
      const storage = {
        my: true,
        pos: new RoomPosition(16, 28, 'W1N1'),
      };
      const room = mockRoom({ name: 'W1N1', storage });
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'DELIVER', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(16, 27, 'W1N1'),
        store: mockStore({ silicon: 500 }),
        transfer: vi.fn(() => 0),
      });

      depositMiner.run(creep);

      expect(creep.transfer).toHaveBeenCalledWith(storage, 'silicon');
    });

    it('moves toward home storage when not yet in the home room', () => {
      setTarget('W1N1');
      const storage = { my: true, pos: new RoomPosition(16, 28, 'W1N1') };
      const homeRoom = mockRoom({ name: 'W1N1', storage });
      Game.rooms = { W1N1: homeRoom } as any;
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'DELIVER', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
        store: mockStore({ silicon: 500 }),
      });

      depositMiner.run(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, storage.pos, expect.any(Object));
    });

    it('returns to TRAVEL once empty if the target is still active', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'dm1',
        memory: { role: 'depositMiner', state: 'DELIVER', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(16, 27, 'W1N1'),
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1000 },
      });

      depositMiner.run(creep);

      // State-chaining runs TRAVEL's handler too — it should try to path
      // back out toward the (still-set) deposit target.
      expect(moveTo).toHaveBeenCalled();
    });
  });
});
