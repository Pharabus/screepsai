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
  placePerimeterRamparts,
  placeLinks,
  placeTerminal,
  placeFactory,
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

  describe('placePerimeterRamparts — wall→gate reconciliation', () => {
    it('destroys a stale constructedWall sitting on a gate tile (so the gate can open)', () => {
      const wallDestroy = vi.fn(() => OK);
      const room = roomAt(6); // RCL 6, no storage → energy gate skipped
      (Memory as any).rooms = {
        W1N1: { perimeterPlan: { perimeterTiles: ['40,25'], gateTiles: ['40,25'] } },
      };
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(function (
        this: any,
        type: string,
      ) {
        if (type === LOOK_STRUCTURES && this.x === 40 && this.y === 25) {
          return [{ structureType: STRUCTURE_WALL, destroy: wallDestroy }];
        }
        return [];
      });
      try {
        placePerimeterRamparts(room);
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
      }

      expect(wallDestroy).toHaveBeenCalledOnce();
      expect(room.createConstructionSite).not.toHaveBeenCalled(); // returns after the destroy
    });

    it('opens the gate at a pre-RCL5 reclaimed room (foreign wall on a gate tile)', () => {
      // A reclaimed room at RCL 4 inherits the previous owner's wall on what is
      // now a gate tile. Reconciliation must run regardless of RCL so the gate
      // (and the remote road through it) is never sealed. Observed live: W42N59
      // RCL4, west gate 6,26 kept a foreign wall and the road tunnelled around.
      const wallDestroy = vi.fn(() => OK);
      const room = roomAt(4); // RCL 4 — below the new-rampart RCL gate
      (Memory as any).rooms = {
        W1N1: { perimeterPlan: { perimeterTiles: ['40,25'], gateTiles: ['40,25'] } },
      };
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(function (
        this: any,
        type: string,
      ) {
        if (type === LOOK_STRUCTURES && this.x === 40 && this.y === 25) {
          return [{ structureType: STRUCTURE_WALL, destroy: wallDestroy }];
        }
        return [];
      });
      try {
        placePerimeterRamparts(room);
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
      }

      expect(wallDestroy).toHaveBeenCalledOnce(); // reconciliation runs below RCL 5
      expect(room.createConstructionSite).not.toHaveBeenCalled(); // no rampart site at RCL4
    });

    it('opens the gate even when storage is below the perimeter energy threshold', () => {
      const wallDestroy = vi.fn(() => OK);
      const room = roomAt(6, {
        storage: { store: { getUsedCapacity: () => 0 } }, // 0 < PERIMETER_STORAGE_MIN
      });
      (Memory as any).rooms = {
        W1N1: { perimeterPlan: { perimeterTiles: ['40,25'], gateTiles: ['40,25'] } },
      };
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(function (
        this: any,
        type: string,
      ) {
        if (type === LOOK_STRUCTURES && this.x === 40 && this.y === 25) {
          return [{ structureType: STRUCTURE_WALL, destroy: wallDestroy }];
        }
        return [];
      });
      try {
        placePerimeterRamparts(room);
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
      }

      expect(wallDestroy).toHaveBeenCalledOnce(); // reconciliation runs before the energy gate
    });
  });

  describe('placeLinks', () => {
    it('does not place before RCL 5', () => {
      const room = roomAt(4);
      placeLinks(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places link near the highest-pathDist source first', () => {
      // Source A is far (pathDist=60, pos at 39,20); source B is close (pathDist=10, pos at 10,10).
      // placeLinks should sort A before B and place the construction site near A's container.
      const containerAPos = new RoomPosition(38, 20, 'W1N1');
      const containerBPos = new RoomPosition(10, 10, 'W1N1');
      const sourceAPos = new RoomPosition(39, 20, 'W1N1');
      const sourceBPos = new RoomPosition(10, 10, 'W1N1');

      const containerA = { id: 'cntA', pos: containerAPos };
      const containerB = { id: 'cntB', pos: containerBPos };
      const sourceA = { id: 'srcA', pos: sourceAPos };
      const sourceB = { id: 'srcB', pos: sourceBPos };

      (Game as any).getObjectById = vi.fn((id: string) => {
        if (id === 'srcA') return sourceA;
        if (id === 'srcB') return sourceB;
        if (id === 'cntA') return containerA;
        if (id === 'cntB') return containerB;
        return null;
      });

      const room = roomAt(6, {
        storage: { my: true, pos: new RoomPosition(25, 25, 'W1N1') },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(16, 31, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) return opts?.filter ? [] : [];
          if (type === FIND_MY_CONSTRUCTION_SITES) return opts?.filter ? [] : [];
          return [];
        }),
      });

      (Memory as any).rooms = {
        W1N1: {
          // storageLinkId set so priority 1 (storage link) is skipped
          storageLinkId: 'existingStorageLink',
          sources: [
            { id: 'srcA', x: 39, y: 20, containerId: 'cntA', pathDist: 60 },
            { id: 'srcB', x: 10, y: 10, containerId: 'cntB', pathDist: 10 },
          ],
        },
      };

      placeLinks(room);

      // Should place a site — and the position should be near containerA (range 1 of 38,20)
      expect(room.createConstructionSite).toHaveBeenCalledOnce();
      const [placedPos] = (room.createConstructionSite as any).mock.calls[0] as [RoomPosition];
      expect(Math.abs(placedPos.x - containerAPos.x) <= 1).toBe(true);
      expect(Math.abs(placedPos.y - containerAPos.y) <= 1).toBe(true);
    });

    describe('storage-link range-1 fallback (built-out room)', () => {
      // findOpenPosition (range 2–3) finds nothing because every ring tile reads as
      // blocked; the fallback must then place on a non-sealing range-1 tile.
      let origLookFor: any;
      beforeEach(() => {
        origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
        (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(() => [
          { structureType: STRUCTURE_EXTENSION },
        ]);
      });
      afterEach(() => {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
      });

      it('places a storage link on a range-1 tile, clearing the road there', () => {
        const storagePos = new RoomPosition(16, 29, 'W1N1');
        const road = { structureType: STRUCTURE_ROAD, destroy: vi.fn(() => OK) };
        const room = roomAt(7, {
          storage: { my: true, pos: storagePos },
          // Every range-1 neighbour of storage is a (clearable) road → 8 passable tiles.
          lookForAt: vi.fn((type: string, x: number, y: number) => {
            if (type !== LOOK_STRUCTURES) return [];
            const cheb = Math.max(Math.abs(x - 16), Math.abs(y - 29));
            return cheb === 1 ? [road] : [];
          }),
        });
        (Memory as any).rooms = { W1N1: { sources: [] } };

        placeLinks(room);

        expect(room.createConstructionSite).toHaveBeenCalledOnce();
        const call = (room.createConstructionSite as any).mock.calls[0];
        const [x, y, type] = call;
        expect(type).toBe(STRUCTURE_LINK);
        expect(Math.max(Math.abs(x - 16), Math.abs(y - 29))).toBe(1); // adjacent to storage
        expect(road.destroy).toHaveBeenCalledOnce(); // road blocker cleared first
      });

      it('does NOT place a range-1 link that would seal storage (only one passable neighbour)', () => {
        const storagePos = new RoomPosition(16, 29, 'W1N1');
        const road = { structureType: STRUCTURE_ROAD, destroy: vi.fn(() => OK) };
        const extension = { structureType: STRUCTURE_EXTENSION };
        const room = roomAt(7, {
          storage: { my: true, pos: storagePos },
          // Only (15,29) is a road; the other 7 neighbours are extensions (impassable).
          lookForAt: vi.fn((type: string, x: number, y: number) => {
            if (type !== LOOK_STRUCTURES) return [];
            const cheb = Math.max(Math.abs(x - 16), Math.abs(y - 29));
            if (cheb !== 1) return [];
            return x === 15 && y === 29 ? [road] : [extension];
          }),
        });
        (Memory as any).rooms = { W1N1: { sources: [] } };

        placeLinks(room);

        expect(room.createConstructionSite).not.toHaveBeenCalled();
        expect(road.destroy).not.toHaveBeenCalled();
      });

      it('does NOT pick a corridor tile that severs the local north/south passage', () => {
        // Mini-W43N58: storage at (16,29). (15,29) is the ONLY passable y=29 tile —
        // the single stepping-stone bridging the north pocket to the south roads.
        // Picking it would force a long detour; the fallback must avoid it.
        const storagePos = new RoomPosition(16, 29, 'W1N1');
        const roadDestroy = vi.fn(() => OK);
        const roadSet = new Set([
          '15,29', // the bridge (the tile we must NOT choose)
          '15,30',
          '15,31',
          '16,32',
          '17,30',
          '17,31',
          '14,31',
          '15,32',
          '17,32', // south roads
          '16,28',
          '16,27',
          '14,27',
          '14,28',
          '15,26',
          '16,26', // north pocket
        ]);
        const room = roomAt(7, {
          storage: { my: true, pos: storagePos },
          getTerrain: () => ({ get: () => 0 }),
          lookForAt: vi.fn((type: string, x: number, y: number) => {
            if (type !== LOOK_STRUCTURES) return [];
            const k = `${x},${y}`;
            if (k === '16,29') return [{ structureType: STRUCTURE_STORAGE }];
            if (roadSet.has(k)) return [{ structureType: STRUCTURE_ROAD, destroy: roadDestroy }];
            return [{ structureType: STRUCTURE_EXTENSION }]; // everything else walls the corridor
          }),
        });
        (Memory as any).rooms = { W1N1: { sources: [] } };

        placeLinks(room);

        expect(room.createConstructionSite).toHaveBeenCalledOnce();
        const [x, y, type] = (room.createConstructionSite as any).mock.calls[0];
        expect(type).toBe(STRUCTURE_LINK);
        expect(Math.max(Math.abs(x - 16), Math.abs(y - 29))).toBe(1); // adjacent to storage
        expect(`${x},${y}`).not.toBe('15,29'); // never the severing bridge tile
      });

      it('does NOT pick a tile that is an adjacent extension’s only access', () => {
        // storage (16,29). Two road candidates: 15,29 and 17,30. The extension at
        // (14,29) has only one passable neighbour — 15,29 — so taking 15,29 would
        // strand it. The guard must choose 17,30 instead.
        const storagePos = new RoomPosition(16, 29, 'W1N1');
        const roadDestroy = vi.fn(() => OK);
        const roadSet = new Set(['15,29', '17,30', '17,31', '16,32', '18,30']);
        const room = roomAt(7, {
          storage: { my: true, pos: storagePos },
          getTerrain: () => ({ get: () => 0 }),
          lookForAt: vi.fn((type: string, x: number, y: number) => {
            if (type !== LOOK_STRUCTURES) return [];
            const k = `${x},${y}`;
            if (k === '16,29') return [{ structureType: STRUCTURE_STORAGE }];
            if (roadSet.has(k)) return [{ structureType: STRUCTURE_ROAD, destroy: roadDestroy }];
            return [{ structureType: STRUCTURE_EXTENSION }]; // 14,29 et al. are extensions
          }),
        });
        (Memory as any).rooms = { W1N1: { sources: [] } };

        placeLinks(room);

        expect(room.createConstructionSite).toHaveBeenCalledOnce();
        const [x, y, type] = (room.createConstructionSite as any).mock.calls[0];
        expect(type).toBe(STRUCTURE_LINK);
        expect(`${x},${y}`).toBe('17,30'); // 15,29 would strand the 14,29 extension
      });
    });
  });

  describe('placeTerminal', () => {
    it('does not place before RCL 6', () => {
      const room = roomAt(5);
      placeTerminal(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });
  });

  describe('placeFactory', () => {
    it('does not place before RCL 7', () => {
      const room = roomAt(6);
      placeFactory(room);
      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('places at RCL 7 when storage exists and no factory present', () => {
      const storagePos = new RoomPosition(27, 25, 'W1N1');
      const room = roomAt(7, {
        storage: { my: true, pos: storagePos },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) return [];
            return [];
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      placeFactory(room);
      expect(room.createConstructionSite).toHaveBeenCalledWith(
        expect.any(Object),
        STRUCTURE_FACTORY,
      );
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
        storage: { my: true, pos: storagePos },
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
        storage: { my: true, pos: storagePos },
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
        storage: { my: true, pos: storagePos },
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
        storage: { my: true, pos: storagePos },
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

    it('rate-limits blocked log per (x,y) to once per 100 ticks', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Save and override RoomPosition.prototype.lookFor so lab stamp positions appear blocked
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(() => [
        { structureType: STRUCTURE_ROAD },
      ]);
      try {
        const room = roomAt(7, { storage: { my: true, pos: { x: 25, y: 25 } } });
        (Memory as any).rooms = {
          W1N1: {
            layoutPlan: {
              storagePos: { x: 25, y: 25 },
              terminalPos: { x: 24, y: 24 },
              towerPositions: [],
              labPositions: [{ x: 10, y: 10 }],
              extensionPositions: [],
            },
          },
        };
        (Game as any).time = 1;
        placeLabs(room);
        expect(logSpy).toHaveBeenCalledTimes(1);

        // 5 more calls within 100 ticks — still only 1 emission
        for (let i = 0; i < 5; i++) placeLabs(room);
        expect(logSpy).toHaveBeenCalledTimes(1);

        // Advance past 100 ticks — log fires again
        (Game as any).time = 102;
        placeLabs(room);
        expect(logSpy).toHaveBeenCalledTimes(2);
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
        logSpy.mockRestore();
      }
    });

    it('logs once per blocked position even when multiple positions are blocked', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn(() => [
        { structureType: STRUCTURE_ROAD },
      ]);
      try {
        const room = roomAt(7, { storage: { my: true, pos: { x: 25, y: 25 } } });
        (Memory as any).rooms = {
          W1N1: {
            layoutPlan: {
              storagePos: { x: 25, y: 25 },
              terminalPos: { x: 24, y: 24 },
              towerPositions: [],
              labPositions: [
                { x: 10, y: 10 },
                { x: 11, y: 11 },
              ],
              extensionPositions: [],
            },
          },
        };
        (Game as any).time = 1;
        placeLabs(room);
        // Two positions blocked → two log emissions on first call
        expect(logSpy).toHaveBeenCalledTimes(2);

        // Second call within 100 ticks → no more emissions
        placeLabs(room);
        expect(logSpy).toHaveBeenCalledTimes(2);
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
        logSpy.mockRestore();
      }
    });

    it('does not log when plan positions are all occupied by already-built labs', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      // All positions return an existing STRUCTURE_LAB — no noise expected
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn((type: string) =>
        type === LOOK_STRUCTURES ? [{ structureType: STRUCTURE_LAB }] : [],
      );
      // ^ also covers [lab, rampart] coexistence — see the test below
      try {
        const room = roomAt(7, {
          storage: { my: true, pos: { x: 25, y: 25 } },
          find: vi.fn((type: number, opts?: any) => {
            if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
            if (type === FIND_MY_STRUCTURES) {
              // 6 labs < 9 max → triggers loop; give them positions so the
              // adjacency overflow can resolve input anchors (real labs have pos).
              if (opts?.filter)
                return Array.from({ length: 6 }, (_, i) => ({
                  structureType: STRUCTURE_LAB,
                  pos: new RoomPosition(10 + i, 10, 'W1N1'),
                }));
              return [];
            }
            if (type === FIND_MY_CONSTRUCTION_SITES) return [];
            return [];
          }),
        });
        (Memory as any).rooms = {
          W1N1: {
            layoutPlan: {
              storagePos: { x: 25, y: 25 },
              terminalPos: { x: 24, y: 24 },
              towerPositions: [],
              labPositions: [
                { x: 10, y: 10 },
                { x: 11, y: 11 },
              ],
              extensionPositions: [],
            },
          },
        };
        (Game as any).time = 1;
        placeLabs(room);
        expect(logSpy).not.toHaveBeenCalled();
        // Every tile reports an existing lab via the lookFor override, so the
        // adjacency overflow finds no open tile and places nothing.
        expect(room.createConstructionSite).not.toHaveBeenCalled();
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
        logSpy.mockRestore();
      }
    });

    it('does not log when lab position has both a lab and a rampart (tile coexistence)', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
      // Ramparts coexist on the same tile as labs in protected rooms — structs
      // contains [lab, rampart]; the isBuiltLab check must use .some(), not .every()
      (globalThis as any).RoomPosition.prototype.lookFor = vi.fn((type: string) =>
        type === LOOK_STRUCTURES
          ? [{ structureType: STRUCTURE_LAB }, { structureType: STRUCTURE_RAMPART }]
          : [],
      );
      try {
        const room = roomAt(7, {
          storage: { my: true, pos: { x: 25, y: 25 } },
          find: vi.fn((type: number, opts?: any) => {
            if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
            if (type === FIND_MY_STRUCTURES) {
              if (opts?.filter)
                return Array.from({ length: 6 }, (_, i) => ({
                  structureType: STRUCTURE_LAB,
                  pos: new RoomPosition(10 + i, 10, 'W1N1'),
                }));
              return [];
            }
            if (type === FIND_MY_CONSTRUCTION_SITES) return [];
            return [];
          }),
        });
        (Memory as any).rooms = {
          W1N1: {
            layoutPlan: {
              storagePos: { x: 25, y: 25 },
              terminalPos: { x: 24, y: 24 },
              towerPositions: [],
              labPositions: [{ x: 10, y: 10 }],
              extensionPositions: [],
            },
          },
        };
        (Game as any).time = 1;
        placeLabs(room);
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
        logSpy.mockRestore();
      }
    });
  });

  describe('placeLabs — adjacency-aware overflow (plan short of MAX_LABS)', () => {
    // Models the live W44N57 bug: the rigid LAB_STAMP collided with a spawn /
    // extensions / road at compute time, so the plan only carries the 2 input
    // lab slots (both built). At RCL 7 the room needs 9 labs but the planned
    // loop is exhausted — the overflow must place the extras on adjacency-valid
    // tiles (Chebyshev range 2 of BOTH input labs), never on a stray tile.
    const IN1 = { x: 28, y: 8 };
    const IN2 = { x: 27, y: 8 };

    /**
     * Build a room whose two input labs sit at IN1/IN2 (both built) and whose
     * plan only lists those two positions. Tile occupancy is controlled
     * separately via installOccupancy (RoomPosition.lookFor override).
     */
    function labOverflowRoom(): any {
      const lab1 = {
        structureType: STRUCTURE_LAB,
        id: 'lab1',
        pos: new RoomPosition(IN1.x, IN1.y, 'W1N1'),
      };
      const lab2 = {
        structureType: STRUCTURE_LAB,
        id: 'lab2',
        pos: new RoomPosition(IN2.x, IN2.y, 'W1N1'),
      };
      return roomAt(7, {
        storage: { my: true, pos: new RoomPosition(5, 5, 'W1N1') },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(5, 6, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) {
            if (opts?.filter) return [lab1, lab2]; // 2 labs < 9 max
            return [];
          }
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
        getTerrain: vi.fn(() => ({ get: () => 0 })),
      });
    }

    let origLookFor: any;
    beforeEach(() => {
      origLookFor = (globalThis as any).RoomPosition.prototype.lookFor;
    });
    afterEach(() => {
      (globalThis as any).RoomPosition.prototype.lookFor = origLookFor;
    });

    function installOccupancy(occupied: Set<string>): void {
      (globalThis as any).RoomPosition.prototype.lookFor = function (type: string) {
        if (type !== LOOK_STRUCTURES) return [];
        return occupied.has(`${this.x},${this.y}`) ? [{ structureType: STRUCTURE_LAB }] : [];
      };
    }

    function planWithInputsOnly(): any {
      return {
        layoutPlan: {
          storagePos: { x: 5, y: 5 },
          terminalPos: { x: 6, y: 5 },
          towerPositions: [],
          labPositions: [IN1, IN2], // both built → planned loop exhausted
          extensionPositions: [],
        },
        inputLabIds: ['lab1', 'lab2'],
      };
    }

    function isAdjacencyValid(x: number, y: number): boolean {
      const cheb = (p: { x: number; y: number }) => Math.max(Math.abs(x - p.x), Math.abs(y - p.y));
      return cheb(IN1) <= 2 && cheb(IN2) <= 2;
    }

    it('places an additional adjacency-valid lab when the plan is short of MAX_LABS', () => {
      // Only the two input-lab tiles are occupied; the cluster has free room.
      const occupied = new Set<string>([`${IN1.x},${IN1.y}`, `${IN2.x},${IN2.y}`]);
      installOccupancy(occupied);
      const room = labOverflowRoom();
      (Memory as any).rooms = { W1N1: planWithInputsOnly() };
      (Game as any).time = 1;

      placeLabs(room);

      expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
      const [pos, type] = (room.createConstructionSite as any).mock.calls[0];
      expect(type).toBe(STRUCTURE_LAB);
      // The placed lab must be reaction-valid: within range 2 of BOTH inputs.
      expect(isAdjacencyValid(pos.x, pos.y)).toBe(true);
      // ...and not on an input tile.
      expect(`${pos.x},${pos.y}`).not.toBe(`${IN1.x},${IN1.y}`);
      expect(`${pos.x},${pos.y}`).not.toBe(`${IN2.x},${IN2.y}`);
    });

    it('does NOT place a non-adjacent lab when no adjacency-valid tile is free', () => {
      // Occupy every tile within range 2 of both inputs (the only valid region).
      const occupied = new Set<string>();
      for (let x = 25; x <= 30; x++) {
        for (let y = 6; y <= 10; y++) {
          if (isAdjacencyValid(x, y)) occupied.add(`${x},${y}`);
        }
      }
      // Leave a far-away free tile that the engine could reach but is NOT
      // adjacency-valid — the overflow must refuse it.
      installOccupancy(occupied);
      const room = labOverflowRoom();
      (Memory as any).rooms = { W1N1: planWithInputsOnly() };
      (Game as any).time = 1;

      placeLabs(room);

      expect(room.createConstructionSite).not.toHaveBeenCalled();
    });

    it('does NOT exceed MAX_LABS — no overflow when already at the cap', () => {
      // 9 labs already (RCL7 cap). placeLabs returns before any placement.
      const labs = Array.from({ length: 9 }, (_, i) => ({
        structureType: STRUCTURE_LAB,
        id: `lab${i}`,
        pos: new RoomPosition(25 + (i % 5), 6 + Math.floor(i / 5), 'W1N1'),
      }));
      installOccupancy(new Set());
      const room = roomAt(7, {
        storage: { my: true, pos: new RoomPosition(5, 5, 'W1N1') },
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(5, 6, 'W1N1') }];
          if (type === FIND_MY_STRUCTURES) return opts?.filter ? labs : [];
          if (type === FIND_MY_CONSTRUCTION_SITES) return [];
          return [];
        }),
      });
      (Memory as any).rooms = { W1N1: planWithInputsOnly() };
      (Game as any).time = 1;

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

  it('returns empty set when layoutPlan exists but storagePos is missing (null guard)', () => {
    const room = roomAt(7);
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          // storagePos absent — simulates Memory corruption that caused per-tick TypeError
          terminalPos: { x: 24, y: 25 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    expect(getPlannedReserved(room).size).toBe(0);
  });

  it('returns empty set when layoutPlan = {} (all fields missing)', () => {
    const room = roomAt(7);
    (Memory as any).rooms = { W1N1: { layoutPlan: {} } };
    expect(getPlannedReserved(room).size).toBe(0);
  });

  it('returns empty set when terminalPos is missing', () => {
    const room = roomAt(7);
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 23, y: 25 },
          // terminalPos absent — simulates partial Memory corruption
          towerPositions: [],
          labPositions: [],
          extensionPositions: [],
        },
      },
    };
    expect(getPlannedReserved(room).size).toBe(0);
  });

  it('handles sparse extensionPositions array without throwing', () => {
    const room = roomAt(7);
    (Memory as any).rooms = {
      W1N1: {
        layoutPlan: {
          storagePos: { x: 23, y: 25 },
          terminalPos: { x: 24, y: 25 },
          towerPositions: [],
          labPositions: [],
          extensionPositions: [undefined, { x: 22, y: 23 }], // sparse — hole at index 0
        },
      },
    };
    const reserved = getPlannedReserved(room);
    expect(reserved.has('22,23')).toBe(true);
    expect(reserved.size).toBe(3); // storagePos + terminalPos + valid extension
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
      storage: { my: true, pos: storagePos },
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

  it('placeFactory skips when link site exists', () => {
    const room = roomWithLinkSite(7);
    placeFactory(room);
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

// ---------------------------------------------------------------------------
// placeStorage — ownership-aware guard tests
// ---------------------------------------------------------------------------

describe('placeStorage ownership', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('places storage when only a FOREIGN storage exists (occupies the slot)', () => {
    // The foreign storage is owner-agnostic (room.storage returns it), but .my is false.
    // placeStorage should use myStorage() and proceed to place our own site.
    const foreignStorage = {
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: { getUsedCapacity: () => 100_000 },
    };
    const room = roomAt(4, { storage: foreignStorage });
    (Memory as any).rooms = { W1N1: {} };

    placeStorage(room);

    expect(room.createConstructionSite).toHaveBeenCalled();
  });

  it('skips placement when OWN storage already exists', () => {
    const ownStorage = {
      my: true,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: { getUsedCapacity: () => 50_000 },
    };
    const room = roomAt(4, { storage: ownStorage });
    (Memory as any).rooms = { W1N1: {} };

    placeStorage(room);

    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});
