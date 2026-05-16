import { builder } from '../../src/roles/builder';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

function makeHostileExtension(x = 10, y = 32) {
  return {
    structureType: STRUCTURE_EXTENSION,
    my: false,
    hits: 1000,
    hitsMax: 1000,
    pos: new (globalThis as any).RoomPosition(x, y, 'W1N1'),
  };
}

describe('builder', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  describe('hostile structure dismantling', () => {
    it('dismantles a hostile extension in range', () => {
      const hostile = makeHostileExtension();
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(10, 33, 'W1N1'),
        room: mockRoom({
          find: vi.fn(() => []),
        }),
      });
      creep.pos.findClosestByRange = vi.fn((type: number) =>
        type === FIND_HOSTILE_STRUCTURES ? hostile : null,
      );
      creep.dismantle = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(hostile);
    });

    it('moves toward a hostile extension when out of range', () => {
      const hostile = makeHostileExtension(10, 32);
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        room: mockRoom({
          find: vi.fn(() => []),
        }),
      });
      creep.pos.findClosestByRange = vi.fn((type: number) =>
        type === FIND_HOSTILE_STRUCTURES ? hostile : null,
      );
      creep.dismantle = vi.fn(() => ERR_NOT_IN_RANGE);

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(hostile);
      // moveTo triggers creep.move via PathFinder — verify no crash and state stays BUILD
      expect(creep.memory.state).toBe('BUILD');
    });

    it('prioritises hostile extension over construction sites', () => {
      const hostile = makeHostileExtension();
      const site = {
        structureType: STRUCTURE_CONTAINER,
        id: 'site1',
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
      };
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(10, 33, 'W1N1'),
        room: mockRoom({
          find: vi.fn(() => [site]),
        }),
      });
      creep.pos.findClosestByRange = vi.fn((type: number) =>
        type === FIND_HOSTILE_STRUCTURES ? hostile : null,
      );
      creep.dismantle = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(hostile);
      expect(creep.build).not.toHaveBeenCalled();
    });

    it('dismantles even when energy store is empty', () => {
      const hostile = makeHostileExtension();
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD' },
        store: { getUsedCapacity: () => 0, getFreeCapacity: () => 50 },
        pos: new (globalThis as any).RoomPosition(10, 33, 'W1N1'),
        room: mockRoom({
          find: vi.fn(() => []),
        }),
      });
      creep.pos.findClosestByRange = vi.fn((type: number) =>
        type === FIND_HOSTILE_STRUCTURES ? hostile : null,
      );
      creep.dismantle = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(hostile);
      // Should NOT have transitioned to GATHER
      expect(creep.memory.state).toBe('BUILD');
    });

    it('proceeds to normal build logic when no hostile structures present', () => {
      const site = {
        structureType: STRUCTURE_CONTAINER,
        id: 'site1',
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
      };
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
        room: mockRoom({
          find: vi.fn(() => [site]),
        }),
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.build = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.build).toHaveBeenCalledWith(site);
      expect(creep.dismantle).not.toHaveBeenCalled();
    });
  });
});
