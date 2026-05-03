import {
  placeExtensions,
  placeTowers,
  placeSourceContainers,
  placeControllerContainer,
  placeStorage,
  placeRoads,
  placeCorridorRoads,
  placeRamparts,
  placeLinks,
  placeTerminal,
  placeExtractor,
  placeMineralContainer,
  placeLabs,
  placeRemoteRoads,
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

    it('does not place if already at max for RCL', () => {
      const storagePos = new RoomPosition(25, 25, 'W1N1');
      (storagePos as any).lookFor = vi.fn(() => []);
      const room = roomAt(6, {
        storage: { pos: storagePos },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) {
              // Return 3 labs (max for RCL 6)
              return [{}, {}, {}];
            }
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
