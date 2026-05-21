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

  describe.skip('lab stamp road clearance (removed — builder no longer dismantles stamp tiles)', () => {
    // These tests covered Pass 2 dismantle scan which was removed in v1.0.151.
    // The isAccessible filter in pickLabPositions is the correct fix; see layoutPlanner.test.ts.
    const labPlan = {
      storagePos: { x: 8, y: 8 },
      terminalPos: { x: 7, y: 8 },
      towerPositions: [],
      labPositions: [] as { x: number; y: number }[], // planner would exclude road-blocked tiles
      extensionPositions: [],
    };

    it('dismantles road on planned lab stamp tile within range 3', () => {
      // Road at LAB_STAMP[0] = (10,10) from anchor (10,10)
      const road = {
        structureType: STRUCTURE_ROAD,
        pos: new (globalThis as any).RoomPosition(10, 10, 'W1N1'),
      };
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn((type: number, x: number, y: number) => {
          if (type === LOOK_STRUCTURES && x === 10 && y === 10) return [road];
          return [];
        }),
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(10, 12, 'W1N1'), // range 2 from road
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => OK);
      (Memory as any).rooms = { W1N1: { layoutPlan: labPlan } };

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(road);
    });

    it('moves toward road on lab stamp tile when adjacent dismantle fails', () => {
      const road = {
        structureType: STRUCTURE_ROAD,
        pos: new (globalThis as any).RoomPosition(10, 10, 'W1N1'),
      };
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn((type: number, x: number, y: number) => {
          if (type === LOOK_STRUCTURES && x === 10 && y === 10) return [road];
          return [];
        }),
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(10, 12, 'W1N1'),
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => ERR_NOT_IN_RANGE);

      (Memory as any).rooms = { W1N1: { layoutPlan: labPlan } };

      builder.run(creep);

      expect(creep.dismantle).toHaveBeenCalledWith(road);
      expect(creep.memory.state).toBe('BUILD');
    });

    it('does not dismantle road on lab stamp tile outside range 3', () => {
      const road = {
        structureType: STRUCTURE_ROAD,
        pos: new (globalThis as any).RoomPosition(10, 10, 'W1N1'),
      };
      const site = {
        structureType: STRUCTURE_CONTAINER,
        id: 'site1',
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
      };
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn((type: number, x: number, y: number) => {
          if (type === LOOK_STRUCTURES && x === 10 && y === 10) return [road];
          return [];
        }),
        find: vi.fn(() => [site]),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'), // range 16 from road
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => OK);
      creep.build = vi.fn(() => OK);
      (Memory as any).rooms = { W1N1: { layoutPlan: labPlan } };

      builder.run(creep);

      expect(creep.dismantle).not.toHaveBeenCalled();
      expect(creep.build).toHaveBeenCalledWith(site);
    });

    it('skips lab stamp tile that already has a lab built', () => {
      const road = {
        structureType: STRUCTURE_ROAD,
        pos: new (globalThis as any).RoomPosition(10, 10, 'W1N1'),
      };
      const site = {
        structureType: STRUCTURE_CONTAINER,
        id: 'site1',
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
      };
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn((type: number, x: number, y: number) => {
          // LAB_STAMP[0] (10,10) has a lab + road — should be skipped
          if (type === LOOK_STRUCTURES && x === 10 && y === 10)
            return [{ structureType: STRUCTURE_LAB }, road];
          return [];
        }),
        find: vi.fn(() => [site]),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(10, 12, 'W1N1'),
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => OK);
      creep.build = vi.fn(() => OK);
      (Memory as any).rooms = { W1N1: { layoutPlan: labPlan } };

      builder.run(creep);

      expect(creep.dismantle).not.toHaveBeenCalled();
      expect(creep.build).toHaveBeenCalledWith(site);
    });

    it('does not dismantle RCL 8 slot when at RCL 7 with all 9 labs present', () => {
      // Anchor (10,10). LAB_STAMP indices 0-8 have labs (RCL 7 cap = 9).
      // LAB_STAMP[9] = [-1,1] → world (9,11): road in RCL 8 slot — must NOT be touched at RCL 7.
      const rcl8Road = {
        structureType: STRUCTURE_ROAD,
        pos: new (globalThis as any).RoomPosition(9, 11, 'W1N1'),
      };
      // Actual world positions for LAB_STAMP[0..8] with anchor (10,10):
      const rcl7WorldPositions: [number, number][] = [
        [10, 10],
        [11, 11],
        [10, 11],
        [11, 10],
        [12, 11],
        [11, 12],
        [12, 10],
        [10, 12],
        [12, 12],
      ];

      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn((type: number, x: number, y: number) => {
          if (type === LOOK_STRUCTURES) {
            if (rcl7WorldPositions.some(([px, py]) => px === x && py === y))
              return [{ structureType: STRUCTURE_LAB }];
            if (x === 9 && y === 11) return [rcl8Road];
          }
          return [];
        }),
        find: vi.fn(() => []),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(9, 12, 'W1N1'), // range 1 from rcl8Road
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => OK);
      (Memory as any).rooms = { W1N1: { layoutPlan: labPlan } };

      builder.run(creep);

      expect(creep.dismantle).not.toHaveBeenCalled();
    });

    it('does nothing when no layoutPlan in memory', () => {
      const site = {
        structureType: STRUCTURE_CONTAINER,
        id: 'site1',
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
      };
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7, my: true },
        lookForAt: vi.fn(() => []),
        find: vi.fn(() => [site]),
      });
      const creep = mockCreep({
        memory: { role: 'builder', state: 'BUILD', homeRoom: 'W1N1' },
        store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
        pos: new (globalThis as any).RoomPosition(26, 5, 'W1N1'),
        room,
      });
      creep.pos.findClosestByRange = vi.fn(() => null);
      creep.dismantle = vi.fn(() => OK);
      creep.build = vi.fn(() => OK);
      (Memory as any).rooms = { W1N1: {} }; // no layoutPlan

      builder.run(creep);

      expect(creep.dismantle).not.toHaveBeenCalled();
      expect(creep.build).toHaveBeenCalledWith(site);
    });

    describe('W43N58 exact regression', () => {
      // storagePos = (16,29) → lab anchor = (18,31).
      // LAB_STAMP world positions at this anchor:
      //   [0]=(18,31) [1]=(19,32) [2]=(18,32) [3]=(19,31) [4]=(20,32)
      //   [5]=(19,33) ← ROAD  [6]=(20,31)  [7]=(18,33) ← ROAD
      //   [8]=(20,33) ← ROAD  (last RCL7 slot)
      //   [9]=(17,32) ← ROAD  (RCL8 slot — not checked at RCL 7)
      // labPositions (from planner) only contains buildable tiles; roads are excluded.
      const w43n58Plan = {
        storagePos: { x: 16, y: 29 },
        terminalPos: { x: 17, y: 29 },
        towerPositions: [],
        labPositions: [
          { x: 18, y: 31 },
          { x: 19, y: 32 },
          { x: 18, y: 32 },
          { x: 19, y: 31 },
          { x: 20, y: 32 },
          { x: 20, y: 31 },
        ],
        extensionPositions: [],
      };

      it('dismantles the first road-blocked stamp tile (index 5) in RCL 7 cap', () => {
        const roadAt19_33 = {
          structureType: STRUCTURE_ROAD,
          pos: new (globalThis as any).RoomPosition(19, 33, 'W43N58'),
        };
        const roadAt18_33 = {
          structureType: STRUCTURE_ROAD,
          pos: new (globalThis as any).RoomPosition(18, 33, 'W43N58'),
        };
        const roadAt20_33 = {
          structureType: STRUCTURE_ROAD,
          pos: new (globalThis as any).RoomPosition(20, 33, 'W43N58'),
        };

        const room = mockRoom({
          name: 'W43N58',
          controller: { level: 7, my: true },
          lookForAt: vi.fn((type: number, x: number, y: number) => {
            if (type === LOOK_STRUCTURES) {
              if (x === 19 && y === 33) return [roadAt19_33];
              if (x === 18 && y === 33) return [roadAt18_33];
              if (x === 20 && y === 33) return [roadAt20_33];
            }
            return [];
          }),
          find: vi.fn(() => []),
        });
        // Creep at (18,31) — range ≤2 from all three blocked tiles
        const creep = mockCreep({
          name: 'builder_w43',
          memory: { role: 'builder', state: 'BUILD', homeRoom: 'W43N58' },
          store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
          pos: new (globalThis as any).RoomPosition(18, 31, 'W43N58'),
          room,
        });
        creep.pos.findClosestByRange = vi.fn(() => null);
        creep.dismantle = vi.fn(() => OK);
        (Memory as any).rooms = { W43N58: { layoutPlan: w43n58Plan } };

        builder.run(creep);

        // Builder iterates LAB_STAMP in order; (19,33) is at index 5, the first road hit
        expect(creep.dismantle).toHaveBeenCalledWith(roadAt19_33);
      });

      it('does not dismantle RCL 8 slot (17,32) at RCL 7 even when all 9 RCL7 slots have labs', () => {
        const rcl8Road = {
          structureType: STRUCTURE_ROAD,
          pos: new (globalThis as any).RoomPosition(17, 32, 'W43N58'),
        };
        // All 9 RCL7 stamp positions have labs
        const rcl7Positions: [number, number][] = [
          [18, 31],
          [19, 32],
          [18, 32],
          [19, 31],
          [20, 32],
          [19, 33],
          [20, 31],
          [18, 33],
          [20, 33],
        ];

        const room = mockRoom({
          name: 'W43N58',
          controller: { level: 7, my: true },
          lookForAt: vi.fn((type: number, x: number, y: number) => {
            if (type === LOOK_STRUCTURES) {
              if (rcl7Positions.some(([px, py]) => px === x && py === y))
                return [{ structureType: STRUCTURE_LAB }];
              if (x === 17 && y === 32) return [rcl8Road];
            }
            return [];
          }),
          find: vi.fn(() => []),
        });
        const creep = mockCreep({
          name: 'builder_w43',
          memory: { role: 'builder', state: 'BUILD', homeRoom: 'W43N58' },
          store: { getUsedCapacity: () => 50, getFreeCapacity: () => 0 },
          pos: new (globalThis as any).RoomPosition(17, 31, 'W43N58'), // range 1 from (17,32)
          room,
        });
        creep.pos.findClosestByRange = vi.fn(() => null);
        creep.dismantle = vi.fn(() => OK);
        (Memory as any).rooms = { W43N58: { layoutPlan: w43n58Plan } };

        builder.run(creep);

        expect(creep.dismantle).not.toHaveBeenCalled();
      });
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
