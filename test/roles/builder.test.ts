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

  describe('foreign room handling', () => {
    it('does not upgrade a foreign controller when stranded in another room', () => {
      const foreignRoom = mockRoom({
        name: 'W2N1',
        controller: { level: 3, my: false },
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
        room: foreignRoom,
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });

      builder.run(creep);

      expect(creep.upgradeController).not.toHaveBeenCalled();
      expect(creep.build).not.toHaveBeenCalled();
    });

    it('moves toward homeRoom when in a foreign room with no sites', () => {
      const foreignRoom = mockRoom({
        name: 'W2N1',
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        pos: new (globalThis as any).RoomPosition(25, 25, 'W2N1'),
        room: foreignRoom,
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });
      // PathFinder returns a step so moveTo issues a move() call
      (globalThis as any).PathFinder.search = () => ({
        path: [new (globalThis as any).RoomPosition(24, 25, 'W2N1')],
        ops: 0,
        cost: 0,
        incomplete: false,
      });

      builder.run(creep);

      expect(creep.move).toHaveBeenCalled();
      expect(creep.upgradeController).not.toHaveBeenCalled();
    });

    it('upgrades the home controller when in homeRoom with no sites', () => {
      const controller = { level: 2, my: true };
      const homeRoom = mockRoom({
        name: 'W1N1',
        controller,
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        room: homeRoom,
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });
      creep.upgradeController = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    });

    it('treats creep with no homeRoom set as being home', () => {
      const controller = { level: 2, my: true };
      const room = mockRoom({
        name: 'W1N1',
        controller,
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
        room,
        memory: { role: 'builder', state: 'BUILD' }, // no homeRoom field
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
      });
      creep.upgradeController = vi.fn(() => OK);

      builder.run(creep);

      expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    });
  });
});
