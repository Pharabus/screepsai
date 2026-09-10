import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { powerAttacker } from '../../src/roles/powerAttacker';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
  isInRoomInterior: vi.fn(() => true),
}));

import { moveTo, isInRoomInterior } from '../../src/utils/movement';

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

function mockBank(overrides: Record<string, any> = {}): any {
  return {
    id: 'bank1',
    hits: 2000000,
    power: 2000,
    pos: new RoomPosition(20, 20, 'W2N1'),
    ...overrides,
  };
}

describe('powerAttacker', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
    (isInRoomInterior as any).mockReturnValue(true);
    (Memory as any).rooms = {};
  });

  describe('TRAVEL state', () => {
    it('does nothing when no powerBankTarget is set', () => {
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      powerAttacker.run(creep);

      expect(moveTo).not.toHaveBeenCalled();
      // No target -> RETREAT; no home spawn found in this test, so it's a no-op.
      expect(creep.memory.state).toBe('RETREAT');
    });

    it('moves toward the bank room when not there yet', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      powerAttacker.run(creep);

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
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(0, 25, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 25, y: 25 }),
        expect.objectContaining({ range: 20 }),
      );
    });

    it('transitions to ATTACK and attacks once interior and within range 1 of the bank', () => {
      setTarget('W1N1');
      const bank = mockBank();
      Game.getObjectById = vi.fn(() => bank) as any;
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(creep.memory.state).toBe('ATTACK');
      expect(creep.attack).toHaveBeenCalledWith(bank);
    });
  });

  describe('ATTACK state', () => {
    it('attacks the bank when in range', () => {
      setTarget('W1N1');
      const bank = mockBank();
      Game.getObjectById = vi.fn(() => bank) as any;
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'ATTACK', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(creep.attack).toHaveBeenCalledWith(bank);
      expect(moveTo).not.toHaveBeenCalled();
    });

    it('moves closer when out of range of the bank', () => {
      setTarget('W1N1');
      const bank = mockBank();
      Game.getObjectById = vi.fn(() => bank) as any;
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'ATTACK', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(10, 10, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(creep.attack).not.toHaveBeenCalled();
      expect(moveTo).toHaveBeenCalledWith(creep, bank, expect.objectContaining({ range: 1 }));
    });

    it('does NOT retreat when the bank lookup fails but the room is not visible (just dark, not destroyed)', () => {
      setTarget('W1N1');
      Game.getObjectById = vi.fn(() => undefined) as any;
      Game.rooms = {}; // target room not visible this tick
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'ATTACK', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1' }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(creep.memory.state).toBe('ATTACK');
      expect(creep.attack).not.toHaveBeenCalled();
    });

    it('retreats once the bank is confirmed destroyed (visible room, null lookup)', () => {
      setTarget('W1N1');
      Game.getObjectById = vi.fn(() => undefined) as any;
      const room = mockRoom({ name: 'W2N1' });
      Game.rooms = { W2N1: room };
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'ATTACK', homeRoom: 'W1N1' },
        room,
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerAttacker.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });
  });

  describe('RETREAT state', () => {
    it('moves to the home spawn when not adjacent', () => {
      const spawn = { pos: new RoomPosition(15, 15, 'W1N1'), recycleCreep: vi.fn() };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'RETREAT', homeRoom: 'W1N1' },
        room: homeRoom,
        pos: new RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).rooms = { W1N1: homeRoom };

      powerAttacker.run(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, spawn, expect.objectContaining({ range: 1 }));
      expect(spawn.recycleCreep).not.toHaveBeenCalled();
    });

    it('recycles at the spawn once adjacent', () => {
      const spawn = { pos: new RoomPosition(25, 24, 'W1N1'), recycleCreep: vi.fn() };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        name: 'pa1',
        memory: { role: 'powerAttacker', state: 'RETREAT', homeRoom: 'W1N1' },
        room: homeRoom,
        pos: new RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).rooms = { W1N1: homeRoom };

      powerAttacker.run(creep);

      expect(spawn.recycleCreep).toHaveBeenCalledWith(creep);
    });
  });
});
