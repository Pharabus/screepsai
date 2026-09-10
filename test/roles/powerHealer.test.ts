import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { powerHealer } from '../../src/roles/powerHealer';

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

function healerCreep(overrides: Record<string, any> = {}): any {
  return mockCreep({
    name: 'ph1',
    memory: { role: 'powerHealer', state: 'FOLLOW', homeRoom: 'W1N1' },
    room: mockRoom({ name: 'W2N1', find: vi.fn(() => []) }),
    pos: new RoomPosition(20, 21, 'W2N1'),
    rangedHeal: vi.fn(() => 0),
    ...overrides,
  });
}

describe('powerHealer', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
    (isInRoomInterior as any).mockReturnValue(true);
    (Memory as any).rooms = {};
  });

  describe('TRAVEL state', () => {
    it('retreats when no powerBankTarget is set', () => {
      const creep = mockCreep({
        name: 'ph1',
        memory: { role: 'powerHealer', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
      });

      powerHealer.run(creep);

      expect(creep.memory.state).toBe('RETREAT');
    });

    it('moves toward the bank room when not there yet', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'ph1',
        memory: { role: 'powerHealer', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W1N1' }),
        pos: new RoomPosition(25, 25, 'W1N1'),
      });

      powerHealer.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ roomName: 'W2N1', x: 20, y: 20 }),
        expect.objectContaining({ priority: expect.any(Number) }),
      );
    });

    it('transitions to FOLLOW once interior', () => {
      setTarget('W1N1');
      const creep = mockCreep({
        name: 'ph1',
        memory: { role: 'powerHealer', state: 'TRAVEL', homeRoom: 'W1N1' },
        room: mockRoom({ name: 'W2N1', find: vi.fn(() => []) }),
        pos: new RoomPosition(20, 21, 'W2N1'),
      });

      powerHealer.run(creep);

      expect(creep.memory.state).toBe('FOLLOW');
    });
  });

  describe('FOLLOW state', () => {
    it('self-heals when damaged and no more-injured squadmate is closer', () => {
      setTarget('W1N1');
      const creep = healerCreep({ hits: 50, hitsMax: 100 });

      powerHealer.run(creep);

      expect(creep.heal).toHaveBeenCalledWith(creep);
    });

    it('heals the most-injured squadmate in melee range', () => {
      setTarget('W1N1');
      const attacker = {
        name: 'atk1',
        hits: 20,
        hitsMax: 100,
        memory: { role: 'powerAttacker' },
        pos: new RoomPosition(20, 22, 'W2N1'),
      };
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => [attacker]),
      });
      const creep = healerCreep({ room, hits: 100, hitsMax: 100 });
      creep.pos.getRangeTo = (t: any) => (t === attacker ? 1 : 99);

      powerHealer.run(creep);

      expect(creep.heal).toHaveBeenCalledWith(attacker);
    });

    it('holds near the bank position when no squadmate is present yet', () => {
      setTarget('W1N1');
      const creep = healerCreep();

      powerHealer.run(creep);

      expect(moveTo).toHaveBeenCalledWith(
        creep,
        expect.objectContaining({ x: 20, y: 20 }),
        expect.objectContaining({ range: 3 }),
      );
    });

    it('moves to stay adjacent to a found partner', () => {
      setTarget('W1N1');
      const attacker = {
        name: 'atk1',
        hits: 100,
        hitsMax: 100,
        memory: { role: 'powerAttacker' },
        pos: new RoomPosition(20, 25, 'W2N1'),
      };
      const room = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => [attacker]),
      });
      const creep = healerCreep({ room, hits: 100, hitsMax: 100 });
      creep.pos.getRangeTo = () => 5;

      powerHealer.run(creep);

      expect(moveTo).toHaveBeenCalledWith(creep, attacker, expect.objectContaining({ range: 1 }));
    });
  });

  describe('RETREAT state', () => {
    it('recycles at the spawn once home and adjacent', () => {
      const spawn = { pos: new RoomPosition(25, 24, 'W1N1'), recycleCreep: vi.fn() };
      const homeRoom = mockRoom({
        name: 'W1N1',
        find: vi.fn((type: number) => (type === FIND_MY_SPAWNS ? [spawn] : [])),
      });
      const creep = mockCreep({
        name: 'ph1',
        memory: { role: 'powerHealer', state: 'RETREAT', homeRoom: 'W1N1' },
        room: homeRoom,
        pos: new RoomPosition(25, 25, 'W1N1'),
      });
      (Game as any).rooms = { W1N1: homeRoom };

      powerHealer.run(creep);

      expect(spawn.recycleCreep).toHaveBeenCalledWith(creep);
    });
  });
});
