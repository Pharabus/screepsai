import {
  placeExtensions,
  placeTowers,
  placeSourceContainers,
  placeControllerContainer,
  placeStorage,
  placeRoads,
  placeRamparts,
  placeLinks,
  placeTerminal,
  placeExtractor,
  placeMineralContainer,
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
});
