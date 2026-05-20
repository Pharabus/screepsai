import {
  placeExtensions,
  placeTowers,
  placeSourceContainers,
  placeControllerContainer,
  placeStorage,
  placeSecondSpawn,
  placeRoads,
  placeCorridorRoads,
  placeRamparts,
  placeLinks,
  placeTerminal,
  placeExtractor,
  placeMineralContainer,
  placeLabs,
  placeRemoteRoads,
  placeColonyBootstrapRoads,
  clearLabBlockers,
  getPlannedReserved,
} from '../../src/managers/construction';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function roomAt(rcl: number, overrides: Record<string, any> = {}): any {
  const spawn = { pos: new RoomPosition(25, 25, 'W1N1') };
  const controllerPos = new RoomPosition(30, 30, 'W1N1');
  return mockRoom({
    name: 'W1N1',
    controller: { my: true, level: rcl, pos: controllerPos },
    storage: undefined,
    terminal: undefined,
    find: vi.fn((type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [spawn];
      if (type === FIND_MY_STRUCTURES) {
        if (opts?.filter) return [];
        return [];
      }
      if (type === FIND_MY_CONSTRUCTION_SITES) return [];
      if (type === FIND_SOURCES) {
        return [{ pos: new RoomPosition(10, 10, 'W1N1'), id: 'src1' }];
      }
      if (type === FIND_MINERALS) {
        return [{ pos: new RoomPosition(40, 40, 'W1N1'), id: 'min1' }];
      }
      return [];
    }),
    lookForAt: vi.fn(() => []),
    getTerrain: vi.fn(() => ({ get: () => 0 })),
    findPath: vi.fn(() => [{ x: 29, y: 30 }]),
    createConstructionSite: vi.fn(() => 0),
    ...overrides,
  });
}

describe('construction RCL gating', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  describe('placeExtensions', () => {
    it('does not place at RCL 1', () => {
      const room = roomAt(1);
      placeExtensions(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 2', () => {
      const room = roomAt(2);
      placeExtensions(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeTowers', () => {
    it('does not place before RCL 3', () => {
      const room = roomAt(2);
      placeTowers(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 3', () => {
      const room = roomAt(3);
      placeTowers(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });

    it('does not exceed the RCL cap (RCL 7 = max 3, already at 3)', () => {
      // 3 towers already built — at the cap for RCL 7, should not place another
      const room = roomAt(7, {
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            const structs = [
              { structureType: STRUCTURE_TOWER },
              { structureType: STRUCTURE_TOWER },
              { structureType: STRUCTURE_TOWER },
            ];
            return opts?.filter ? structs.filter(opts.filter) : structs;
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      placeTowers(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places 3rd tower at RCL 7 using the first free plan slot', () => {
      // 2 towers built, 1 more needed — plan has 6 positions; first free one is chosen.
      // Note: RoomPosition.lookFor() in the mock always returns [], so all plan positions
      // appear unblocked and position[0] (28,25) is always selected.
      const towerStructures = [
        { structureType: STRUCTURE_TOWER },
        { structureType: STRUCTURE_TOWER },
      ];
      const room = roomAt(7, {
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            return opts?.filter ? towerStructures.filter(opts.filter) : towerStructures;
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      (Memory as any).rooms = {
        W1N1: {
          layoutPlan: {
            towerPositions: [
              { x: 28, y: 25 },
              { x: 22, y: 25 },
              { x: 25, y: 28 },
              { x: 25, y: 22 },
              { x: 28, y: 28 },
              { x: 22, y: 22 },
            ],
          },
        },
      };
      placeTowers(room);
      // First plan position chosen (mock cannot simulate blocked RoomPosition.lookFor)
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.objectContaining({ x: 28, y: 25 }),
        STRUCTURE_TOWER,
      );
    });

    it('falls back to overflow search when plan has no tower positions', () => {
      // 2 towers built, 3rd needed — empty towerPositions forces overflow path.
      // (RoomPosition.lookFor mock always returns [], so we simulate "all blocked"
      // by providing an empty plan rather than trying to mock individual positions.)
      const towerStructures = [
        { structureType: STRUCTURE_TOWER },
        { structureType: STRUCTURE_TOWER },
      ];
      const room = roomAt(7, {
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            return opts?.filter ? towerStructures.filter(opts.filter) : towerStructures;
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      (Memory as any).rooms = {
        W1N1: {
          layoutPlan: {
            towerPositions: [], // exhausted — triggers overflow
          },
        },
      };
      placeTowers(room);
      // Overflow search places somewhere near spawn
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.any(RoomPosition),
        STRUCTURE_TOWER,
      );
    });
  });

  describe('placeSourceContainers', () => {
    it('does not place at RCL 1', () => {
      const room = roomAt(1);
      placeSourceContainers(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 2', () => {
      const room = roomAt(2);
      placeSourceContainers(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeControllerContainer', () => {
    it('does not place at RCL 1', () => {
      const room = roomAt(1);
      placeControllerContainer(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 2', () => {
      const room = roomAt(2);
      placeControllerContainer(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeStorage', () => {
    it('does not place before RCL 4', () => {
      const room = roomAt(3);
      placeStorage(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 4', () => {
      const room = roomAt(4);
      placeStorage(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeRoads', () => {
    it('does not place at RCL 1', () => {
      const room = roomAt(1);
      placeRoads(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 2', () => {
      const room = roomAt(2);
      placeRoads(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeRamparts', () => {
    it('does not place before RCL 3', () => {
      const room = roomAt(2);
      placeRamparts(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 3', () => {
      const spawnPos = new RoomPosition(25, 25, 'W1N1');
      (spawnPos as any).lookFor = vi.fn(() => []);
      const room = roomAt(3, {
        find: vi.fn((type: number) => {
          if (type === FIND_MY_SPAWNS) {
            return [{ pos: spawnPos, structureType: STRUCTURE_SPAWN }];
          }
          if (type === FIND_MY_STRUCTURES) {
            return [{ pos: spawnPos, structureType: STRUCTURE_SPAWN }];
          }
          return [];
        }),
      });
      placeRamparts(room);
      expect(room.createConstructionSite).toHaveBeenCalled();
    });
  });

  describe('placeLinks', () => {
    it('does not place before RCL 5', () => {
      const room = roomAt(4);
      placeLinks(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeTerminal', () => {
    it('does not place before RCL 6', () => {
      const room = roomAt(5);
      placeTerminal(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeExtractor', () => {
    it('does not place before RCL 6', () => {
      const room = roomAt(5);
      placeExtractor(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeMineralContainer', () => {
    it('does not place before RCL 6', () => {
      const room = roomAt(5);
      placeMineralContainer(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeLabs', () => {
    it('does not place before RCL 6', () => {
      const room = roomAt(5);
      placeLabs(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('does not place without storage', () => {
      const room = roomAt(6);
      room.storage = undefined;
      placeLabs(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places a lab at RCL 6 when storage exists', () => {
      const storagePos = new RoomPosition(25, 25, 'W1N1');
      (storagePos as any).lookFor = vi.fn(() => []);
      const room = roomAt(6, {
        storage: { pos: storagePos },
      });
      placeLabs(room);
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.any(RoomPosition),
        STRUCTURE_LAB,
      );
    });

    it('does not place if already at max for RCL 6 (3 labs)', () => {
      const storagePos = new RoomPosition(25, 25, 'W1N1');
      (storagePos as any).lookFor = vi.fn(() => []);
      const room = roomAt(6, {
        storage: { pos: storagePos },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) return Array(3).fill({}); // 3 labs = RCL 6 max
            return [];
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      placeLabs(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places a lab at RCL 7 when fewer than 9 exist', () => {
      const storagePos = new RoomPosition(25, 25, 'W1N1');
      (storagePos as any).lookFor = vi.fn(() => []);
      const room = roomAt(7, {
        storage: { pos: storagePos },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) return Array(6).fill({}); // 6 labs < RCL 7 max (9)
            return [];
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      placeLabs(room);
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.any(RoomPosition),
        STRUCTURE_LAB,
      );
    });

    it('does not place at RCL 7 when already at 9 labs', () => {
      const storagePos = new RoomPosition(25, 25, 'W1N1');
      (storagePos as any).lookFor = vi.fn(() => []);
      const room = roomAt(7, {
        storage: { pos: storagePos },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) return Array(9).fill({}); // 9 labs = RCL 7 max
            return [];
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      placeLabs(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeCorridorRoads', () => {
    it('does not place before RCL 3', () => {
      const room = roomAt(2);
      placeCorridorRoads(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places a corridor road at RCL 3', () => {
      const room = roomAt(3);
      placeCorridorRoads(room);
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        STRUCTURE_ROAD,
      );
    });
  });
});

describe('getPlannedReserved', () => {
  beforeEach(() => resetGameGlobals());

  it('returns empty set when no layoutPlan exists', () => {
    const room = roomAt(7);
    (Memory as any).rooms = { W1N1: {} };
    expect(getPlannedReserved(room).size).toBe(0);
  });

  it('returns empty set when Memory.rooms entry is missing', () => {
    const room = roomAt(7);
    (Memory as any).rooms = {};
    expect(getPlannedReserved(room).size).toBe(0);
  });

  it('includes storagePos, terminalPos, towers, labs, and extensions', () => {
    const room = roomAt(7);
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 23, y: 25 },
          terminalPos: { x: 24, y: 25 },
          towerPositions: [{ x: 28, y: 25 }],
          labPositions: [
            { x: 25, y: 28 },
            { x: 26, y: 28 },
          ],
          extensionPositions: [{ x: 22, y: 23 }],
        },
      },
    };
    const reserved = getPlannedReserved(room);
    expect(reserved.has('23,25')).toBe(true); // storagePos
    expect(reserved.has('24,25')).toBe(true); // terminalPos
    expect(reserved.has('28,25')).toBe(true); // tower
    expect(reserved.has('25,28')).toBe(true); // lab
    expect(reserved.has('26,28')).toBe(true); // lab
    expect(reserved.has('22,23')).toBe(true); // extension
    expect(reserved.size).toBe(6);
  });
});

describe('reserved-tile road avoidance', () => {
  beforeEach(() => resetGameGlobals());

  it('placeRoads does not place a road on a planned structure tile (belt-and-braces)', () => {
    // findPath mock returns [{x:29, y:30}] — if that tile is reserved, no road is placed.
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 29, y: 30 }, // same as the mocked path step
          terminalPos: { x: 0, y: 0 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    const room = roomAt(4);
    placeRoads(room);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(29, 30, STRUCTURE_ROAD);
    // All steps reserved → no road placed at all
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('placeCorridorRoads skips a corridor tile that appears in the layout plan', () => {
    // Spawn at (25,25), RCL 3 → maxRing=2. First corridor candidate is (25,23) (offset=-2).
    // If that tile is reserved (planned tower), the function must skip it.
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 0, y: 0 },
          terminalPos: { x: 0, y: 0 },
          towerPositions: [{ x: 25, y: 23 }], // first corridor candidate
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    const room = roomAt(3);
    placeCorridorRoads(room);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(25, 23, STRUCTURE_ROAD);
    // Some other corridor tile should still have been roaded
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      STRUCTURE_ROAD,
    );
  });
});

describe('placeTowers overflow warning', () => {
  beforeEach(() => resetGameGlobals());

  it('logs overflow warning when all planned slots are blocked and stores it in memory', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const towerStructures = [
      { structureType: STRUCTURE_TOWER },
      { structureType: STRUCTURE_TOWER },
    ];
    const room = roomAt(7, {
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
        if (type === FIND_MY_STRUCTURES)
          return opts?.filter ? towerStructures.filter(opts.filter) : towerStructures;
        if (type === FIND_MY_CONSTRUCTION_SITES) return [];
        return [];
      }),
    });
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 0, y: 0 },
          terminalPos: { x: 0, y: 0 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    placeTowers(room);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('overflow tower'));
    expect((Memory as any).rooms.W1N1.overflowedTowers).toHaveLength(1);
    consoleSpy.mockRestore();
  });

  it('does not repeat overflow warning for the same position', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const towerStructures = [
      { structureType: STRUCTURE_TOWER },
      { structureType: STRUCTURE_TOWER },
    ];
    const room = roomAt(7, {
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
        if (type === FIND_MY_STRUCTURES)
          return opts?.filter ? towerStructures.filter(opts.filter) : towerStructures;
        if (type === FIND_MY_CONSTRUCTION_SITES) return [];
        return [];
      }),
    });
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 0, y: 0 },
          terminalPos: { x: 0, y: 0 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    placeTowers(room); // first call: warning logged
    consoleSpy.mockClear();
    placeTowers(room); // second call: same position, no warning
    expect(consoleSpy).not.toHaveBeenCalled();
    // Site is still placed on second call
    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe('link-first gating', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  function roomWithLinkSite(rcl: number): any {
    const storagePos = new RoomPosition(25, 25, 'W1N1');
    (storagePos as any).lookFor = vi.fn(() => []);
    const mineralPos = new RoomPosition(40, 40, 'W1N1');
    (mineralPos as any).lookFor = vi.fn(() => []);
    return roomAt(rcl, {
      storage: { pos: storagePos },
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
        if (type === FIND_MY_CONSTRUCTION_SITES) {
          if (opts?.filter) {
            const site = { structureType: STRUCTURE_LINK };
            if (opts.filter(site)) return [site];
            return [];
          }
          return [{ structureType: STRUCTURE_LINK }];
        }
        if (type === FIND_MY_STRUCTURES) return [];
        if (type === FIND_MINERALS) return [{ pos: mineralPos, id: 'min1' }];
        return [];
      }),
    });
  }

  it('placeTerminal skips when link site exists', () => {
    const room = roomWithLinkSite(6);
    placeTerminal(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('placeExtractor skips when link site exists', () => {
    const room = roomWithLinkSite(6);
    placeExtractor(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('placeMineralContainer skips when link site exists', () => {
    const room = roomWithLinkSite(6);
    placeMineralContainer(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('placeLabs skips when link site exists', () => {
    const room = roomWithLinkSite(6);
    placeLabs(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

describe('placeRemoteRoads', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('does nothing below RCL 4', () => {
    const room = roomAt(3);
    Memory.rooms = { W1N1: { remoteRooms: ['W2N1'] } };
    placeRemoteRoads(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does nothing without remote rooms', () => {
    const room = roomAt(4);
    Memory.rooms = { W1N1: {} };
    placeRemoteRoads(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does nothing without an active reserver', () => {
    const room = roomAt(4);
    Memory.rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { scoutedHasController: true, sources: [{ id: 's1' as any, x: 25, y: 25 }] },
    };
    (Game as any).creeps = {};
    placeRemoteRoads(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places a road on the first unroaded path step', () => {
    const remoteRoom = mockRoom({
      name: 'W2N1',
      controller: undefined,
      find: vi.fn(() => []),
      lookForAt: vi.fn(() => []),
      createConstructionSite: vi.fn(() => 0),
    });
    const room = roomAt(4);
    Memory.rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { scoutedHasController: true, sources: [{ id: 's1' as any, x: 25, y: 25 }] },
    };
    (Game as any).creeps = {
      res1: { memory: { role: 'reserver', targetRoom: 'W2N1' } },
    };
    (Game as any).rooms = { W1N1: room, W2N1: remoteRoom };

    const pathStep = new RoomPosition(3, 3, 'W2N1');
    (PathFinder as any).search = vi.fn(() => ({
      path: [pathStep],
      incomplete: false,
    }));

    placeRemoteRoads(room);

    expect(remoteRoom.createConstructionSite).toHaveBeenCalledWith(3, 3, STRUCTURE_ROAD);
  });

  it('skips steps that already have roads', () => {
    const room = roomAt(4);
    const remoteRoom = mockRoom({
      name: 'W2N1',
      controller: undefined,
      find: vi.fn(() => []),
      lookForAt: vi.fn((type: string, _x: number, _y: number) => {
        if (type === LOOK_STRUCTURES) return [{ structureType: STRUCTURE_ROAD }];
        return [];
      }),
      createConstructionSite: vi.fn(() => 0),
    });
    Memory.rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { scoutedHasController: true, sources: [{ id: 's1' as any, x: 25, y: 25 }] },
    };
    (Game as any).creeps = {
      res1: { memory: { role: 'reserver', targetRoom: 'W2N1' } },
    };
    (Game as any).rooms = { W1N1: room, W2N1: remoteRoom };

    (PathFinder as any).search = vi.fn(() => ({
      path: [new RoomPosition(3, 3, 'W2N1')],
      incomplete: false,
    }));

    placeRemoteRoads(room);

    expect(remoteRoom.createConstructionSite).not.toHaveBeenCalled();
  });
});

describe('placeColonyBootstrapRoads', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  function bootstrapRoom(roadSiteCount: number, hasStorage = false): any {
    const roadSites = Array.from({ length: roadSiteCount }, () => ({
      structureType: STRUCTURE_ROAD,
    }));
    return mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 2, pos: new RoomPosition(30, 30, 'W1N1') },
      storage: hasStorage ? {} : undefined,
      find: vi.fn((type: number) => {
        if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
        if (type === FIND_MY_CONSTRUCTION_SITES) return roadSites;
        return [];
      }),
      lookForAt: vi.fn(() => []),
      createConstructionSite: vi.fn(() => 0),
    });
  }

  it('does nothing when room has storage (handled by placeRoads)', () => {
    const room = bootstrapRoom(0, true);
    Memory.rooms = { W1N1: { sources: [{ id: 's1' as any, x: 10, y: 10 }] } };
    const result = placeColonyBootstrapRoads(room);
    expect(result).toBe(false);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does not place a road site when road site count exceeds cap', () => {
    const room = bootstrapRoom(4);
    Memory.rooms = { W1N1: { sources: [{ id: 's1' as any, x: 10, y: 10 }] } };
    (PathFinder as any).search = vi.fn(() => ({
      path: [new RoomPosition(26, 25, 'W1N1')],
      incomplete: false,
    }));
    const result = placeColonyBootstrapRoads(room);
    expect(result).toBe(false);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places a road site when below the cap', () => {
    const room = bootstrapRoom(2);
    Memory.rooms = { W1N1: { sources: [{ id: 's1' as any, x: 10, y: 10 }] } };
    (PathFinder as any).search = vi.fn(() => ({
      path: [new RoomPosition(26, 25, 'W1N1')],
      incomplete: false,
    }));
    const result = placeColonyBootstrapRoads(room);
    expect(result).toBe(true);
    expect(room.createConstructionSite).toHaveBeenCalledWith(26, 25, STRUCTURE_ROAD);
  });

  it('skips path steps that overlap planned structure tiles (belt-and-braces)', () => {
    const room = bootstrapRoom(0);
    Memory.rooms = {
      W1N1: {
        sources: [{ id: 's1' as any, x: 10, y: 10 }],
        layoutPlan: {
          storagePos: { x: 26, y: 25 }, // same as the mocked path step
          terminalPos: { x: 0, y: 0 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    (PathFinder as any).search = vi.fn(() => ({
      path: [new RoomPosition(26, 25, 'W1N1')], // reserved tile
      incomplete: false,
    }));
    const result = placeColonyBootstrapRoads(room);
    expect(result).toBe(false); // step was skipped, no road placed
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

describe('clearLabBlockers', () => {
  beforeEach(() => resetGameGlobals());

  function labRoom(rcl: number, labPositions: { x: number; y: number }[]): any {
    const room = roomAt(rcl);
    Memory.rooms = { W1N1: { layoutPlan: { labPositions } } as any };
    return room;
  }

  it('does nothing below RCL 6', () => {
    const room = labRoom(5, [{ x: 10, y: 10 }]);
    room.lookForAt = vi.fn().mockReturnValue([]);
    clearLabBlockers(room);
    expect(room.lookForAt).not.toHaveBeenCalled();
  });

  it('does nothing when no layout plan exists', () => {
    const room = roomAt(6);
    Memory.rooms = { W1N1: {} };
    room.lookForAt = vi.fn().mockReturnValue([]);
    clearLabBlockers(room);
    expect(room.lookForAt).not.toHaveBeenCalled();
  });

  it('destroys an extension blocking a planned lab position', () => {
    const room = labRoom(6, [{ x: 10, y: 10 }]);
    const blocker = { structureType: STRUCTURE_EXTENSION, destroy: vi.fn() };
    room.lookForAt = vi.fn((type: string) => (type === LOOK_STRUCTURES ? [blocker] : []));
    clearLabBlockers(room);
    expect(blocker.destroy).toHaveBeenCalled();
  });

  it('cancels an extension construction site blocking a planned lab position', () => {
    const room = labRoom(6, [{ x: 10, y: 10 }]);
    const site = { structureType: STRUCTURE_EXTENSION, remove: vi.fn() };
    room.lookForAt = vi.fn((type: string) => (type === LOOK_STRUCTURES ? [] : [site]));
    clearLabBlockers(room);
    expect(site.remove).toHaveBeenCalled();
  });

  it('does nothing when lab positions are clear', () => {
    const room = labRoom(6, [{ x: 10, y: 10 }]);
    room.lookForAt = vi.fn().mockReturnValue([]);
    clearLabBlockers(room);
    expect(room.lookForAt).toHaveBeenCalled();
  });

  it('only demolishes one blocker per call', () => {
    const room = labRoom(6, [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
    ]);
    const blocker1 = { structureType: STRUCTURE_EXTENSION, destroy: vi.fn() };
    const blocker2 = { structureType: STRUCTURE_EXTENSION, destroy: vi.fn() };
    room.lookForAt = vi.fn((type: string, x: number) =>
      type === LOOK_STRUCTURES ? (x === 10 ? [blocker1] : [blocker2]) : [],
    );
    clearLabBlockers(room);
    expect(blocker1.destroy).toHaveBeenCalledTimes(1);
    expect(blocker2.destroy).not.toHaveBeenCalled();
  });
});

describe('placeSecondSpawn', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  function spawnRoom(rcl: number, spawnPositions: { x: number; y: number }[]): any {
    // placeSecondSpawn reads from the global Memory, not room.memory
    Memory.rooms['W1N1'] = {
      layoutPlan: {
        spawnPositions,
        towerPositions: [],
        labPositions: [],
        extensionPositions: [],
        storagePos: { x: 30, y: 30 },
        terminalPos: { x: 31, y: 30 },
      },
    };
    return roomAt(rcl);
  }

  it('is a no-op below RCL 7', () => {
    const room = spawnRoom(6, [
      { x: 25, y: 25 },
      { x: 28, y: 25 },
    ]);
    placeSecondSpawn(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places at spawnPositions[1] at RCL 7 when tile is free', () => {
    const room = spawnRoom(7, [
      { x: 25, y: 25 },
      { x: 29, y: 25 },
      { x: 25, y: 29 },
    ]);
    placeSecondSpawn(room);
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      expect.objectContaining({ x: 29, y: 25 }),
      STRUCTURE_SPAWN,
    );
  });

  it('is idempotent when a construction site already occupies spawnPositions[1]', () => {
    const room = spawnRoom(7, [
      { x: 25, y: 25 },
      { x: 29, y: 25 },
      { x: 25, y: 29 },
    ]);
    // 1 built spawn + 1 CS at spawnPositions[1] = 2 = RCL 7 cap → early-out, no new site.
    room.find = vi.fn((type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_MY_STRUCTURES) {
        const spawns = [{ structureType: STRUCTURE_SPAWN }];
        return opts?.filter ? spawns.filter(opts.filter) : spawns;
      }
      if (type === FIND_MY_CONSTRUCTION_SITES) {
        const sites = [{ structureType: STRUCTURE_SPAWN }];
        return opts?.filter ? sites.filter(opts.filter) : sites;
      }
      return [];
    });
    placeSecondSpawn(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places 3rd spawn at RCL 8 when 2 spawns are already built', () => {
    const room = spawnRoom(8, [
      { x: 25, y: 25 },
      { x: 29, y: 25 },
      { x: 25, y: 29 },
    ]);
    // 2 spawns already built + 0 sites → current = 2, max = 3.
    // Index 1 (29,25) is occupied by a live spawn so the loop falls through to index 2.
    room.find = vi.fn((type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_MY_STRUCTURES) {
        const spawns = [{ structureType: STRUCTURE_SPAWN }, { structureType: STRUCTURE_SPAWN }];
        return opts?.filter ? spawns.filter(opts.filter) : spawns;
      }
      if (type === FIND_MY_CONSTRUCTION_SITES) return [];
      return [];
    });
    room.lookForAt = vi.fn((type: string, x: number, y: number) => {
      if (type === LOOK_STRUCTURES && x === 29 && y === 25)
        return [{ structureType: STRUCTURE_SPAWN }];
      return [];
    });
    placeSecondSpawn(room);
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      expect.objectContaining({ x: 25, y: 29 }),
      STRUCTURE_SPAWN,
    );
  });

  it('is a no-op when spawnPositions has fewer than 2 entries', () => {
    const room = spawnRoom(7, [{ x: 25, y: 25 }]);
    placeSecondSpawn(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('is a no-op when current spawn count already meets the RCL cap', () => {
    const room = spawnRoom(7, [
      { x: 25, y: 25 },
      { x: 29, y: 25 },
    ]);
    // 1 built spawn + 1 site = 2 = max at RCL 7
    room.find = vi.fn((type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_MY_STRUCTURES) {
        const spawns = [{ structureType: STRUCTURE_SPAWN }];
        return opts?.filter ? spawns.filter(opts.filter) : spawns;
      }
      if (type === FIND_MY_CONSTRUCTION_SITES) {
        const sites = [{ structureType: STRUCTURE_SPAWN }];
        return opts?.filter ? sites.filter(opts.filter) : sites;
      }
      return [];
    });
    placeSecondSpawn(room);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});
