/**
 * Tests for cleanupClaimedRoom (construction.ts).
 */
import '../mocks/screeps';
import { cleanupClaimedRoom } from '../../src/managers/construction';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

// ---------------------------------------------------------------------------
// cleanupClaimedRoom — cleanup predicate tests
// ---------------------------------------------------------------------------

describe('cleanupClaimedRoom', () => {
  function makeStructure(overrides: Record<string, any>): any {
    return {
      structureType: overrides.structureType ?? STRUCTURE_EXTENSION,
      pos: new (globalThis as any).RoomPosition(
        overrides.x ?? 10,
        overrides.y ?? 10,
        overrides.room ?? 'W1N1',
      ),
      id: overrides.id ?? 'struct1',
      destroy: vi.fn(() => OK),
      ...overrides,
    };
  }

  function makeRoom(
    hostileStructures: any[],
    walls: any[] = [],
    mem: Record<string, any> = {},
    hostileSites: any[] = [],
  ): any {
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 2, pos: new (globalThis as any).RoomPosition(30, 30, 'W1N1') },
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_HOSTILE_STRUCTURES) return hostileStructures;
        if (type === FIND_HOSTILE_CONSTRUCTION_SITES) return hostileSites;
        if (type === FIND_STRUCTURES) {
          // filter for walls
          const filter = opts?.filter ?? (() => true);
          return walls.filter(filter);
        }
        return [];
      }),
    });
    (Memory as any).rooms = { W1N1: mem };
    (Game as any).rooms = { W1N1: room };
    return room;
  }

  function makeSite(overrides: Record<string, any>): any {
    return {
      structureType: overrides.structureType ?? STRUCTURE_ROAD,
      pos: new (globalThis as any).RoomPosition(overrides.x ?? 21, overrides.y ?? 26, 'W1N1'),
      remove: vi.fn(() => OK),
      ...overrides,
    };
  }

  it('destroys empty foreign obstacle structures (extension)', () => {
    const ext = makeStructure({
      structureType: STRUCTURE_EXTENSION,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([ext]);
    cleanupClaimedRoom(room);
    expect(ext.destroy).toHaveBeenCalled();
  });

  it('destroys empty foreign spawn', () => {
    const spawn = makeStructure({
      structureType: STRUCTURE_SPAWN,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([spawn]);
    cleanupClaimedRoom(room);
    expect(spawn.destroy).toHaveBeenCalled();
  });

  it('destroys empty foreign tower', () => {
    const tower = makeStructure({
      structureType: STRUCTURE_TOWER,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([tower]);
    cleanupClaimedRoom(room);
    expect(tower.destroy).toHaveBeenCalled();
  });

  it('destroys empty foreign storage', () => {
    const storage = makeStructure({
      structureType: STRUCTURE_STORAGE,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([storage]);
    cleanupClaimedRoom(room);
    expect(storage.destroy).toHaveBeenCalled();
  });

  it('does NOT destroy foreign storage with resources — records as lootTargetId', () => {
    const storage = makeStructure({
      structureType: STRUCTURE_STORAGE,
      id: 'storage1' as any,
      store: { getUsedCapacity: () => 607_371 },
    });
    const room = makeRoom([storage]);
    cleanupClaimedRoom(room);
    expect(storage.destroy).not.toHaveBeenCalled();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBe('storage1');
  });

  it('does NOT destroy foreign roads', () => {
    const road = makeStructure({
      structureType: STRUCTURE_ROAD,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([road]);
    cleanupClaimedRoom(room);
    expect(road.destroy).not.toHaveBeenCalled();
  });

  it('does NOT destroy foreign containers', () => {
    const container = makeStructure({
      structureType: STRUCTURE_CONTAINER,
      store: { getUsedCapacity: () => 0 },
    });
    const room = makeRoom([container]);
    cleanupClaimedRoom(room);
    expect(container.destroy).not.toHaveBeenCalled();
  });

  it('destroys a non-bulk-store foreign structure even with store > 0 (lab with energy)', () => {
    // A lab/extension/etc. is NOT a loot type: its small store is not worth
    // preserving — it occupies an RCL slot, so it must be destroyed.
    const lab = makeStructure({
      structureType: STRUCTURE_LAB,
      id: 'lab1' as any,
      store: { getUsedCapacity: () => 1000 },
    });
    const room = makeRoom([lab]);
    cleanupClaimedRoom(room);
    expect(lab.destroy).toHaveBeenCalled();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });

  it('destroys a foreign spawn that still holds energy (frees the RCL spawn slot)', () => {
    // Regression for the live W42N59 stall: a 300-energy leftover spawn filled
    // the single RCL spawn slot and blocked our own spawn for the whole bootstrap.
    const spawn = makeStructure({
      structureType: STRUCTURE_SPAWN,
      id: 'bosko_spawn' as any,
      store: { getUsedCapacity: () => 300 },
    });
    const room = makeRoom([spawn]);
    cleanupClaimedRoom(room);
    expect(spawn.destroy).toHaveBeenCalled();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });

  it('does NOT destroy a foreign storage holding any resources (even 1 unit) — drain-then-destroy', () => {
    // New drain-then-destroy policy: spare while storeUsed > 0, regardless of amount.
    // Haulers drain it via withdraw() first; once truly empty it is destroyed next tick.
    const storage = makeStructure({
      structureType: STRUCTURE_STORAGE,
      id: 'small_storage' as any,
      store: { getUsedCapacity: () => 1 }, // just 1 unit — still spared
    });
    const room = makeRoom([storage]);
    cleanupClaimedRoom(room);
    expect(storage.destroy).not.toHaveBeenCalled();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBe('small_storage');
  });

  it('destroys unowned wall that sits on a planned layout tile', () => {
    const wall = makeStructure({
      structureType: STRUCTURE_WALL,
      x: 20,
      y: 20,
      // Unowned: no 'my' property (or my=false)
    });
    const room = makeRoom([], [wall], {
      layoutPlan: {
        version: 1,
        storagePos: { x: 20, y: 20 },
        terminalPos: { x: 21, y: 20 },
        towerPositions: [],
        labPositions: [],
        extensionPositions: [],
        spawnPositions: [],
      },
    });
    cleanupClaimedRoom(room);
    expect(wall.destroy).toHaveBeenCalled();
  });

  it('does NOT destroy unowned wall that is NOT on a planned layout tile', () => {
    const wall = makeStructure({
      structureType: STRUCTURE_WALL,
      x: 5,
      y: 5,
    });
    const room = makeRoom([], [wall], {
      layoutPlan: {
        version: 1,
        storagePos: { x: 20, y: 20 },
        terminalPos: { x: 21, y: 20 },
        towerPositions: [],
        labPositions: [],
        extensionPositions: [],
        spawnPositions: [],
      },
    });
    cleanupClaimedRoom(room);
    expect(wall.destroy).not.toHaveBeenCalled();
  });

  it('does NOT destroy a wall that is in the perimeterPlan', () => {
    const wall = makeStructure({
      structureType: STRUCTURE_WALL,
      x: 20,
      y: 20,
    });
    const room = makeRoom([], [wall], {
      layoutPlan: {
        version: 1,
        storagePos: { x: 20, y: 20 }, // same tile — normally would be destroyed
        terminalPos: { x: 21, y: 20 },
        towerPositions: [],
        labPositions: [],
        extensionPositions: [],
        spawnPositions: [],
      },
      perimeterPlan: {
        version: 1,
        coreRadius: 5,
        perimeterTiles: ['20,20'], // wall is in perimeter plan
        gateTiles: [],
        gateTargets: [],
      },
    });
    cleanupClaimedRoom(room);
    expect(wall.destroy).not.toHaveBeenCalled();
  });

  it('clears stale lootTargetId when structure is gone', () => {
    (Memory as any).rooms = { W1N1: { lootTargetId: 'gone_structure' as any } };
    (Game as any).getObjectById = (_id: string) => null;
    const room = makeRoom([]);
    cleanupClaimedRoom(room);
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });

  it('clears stale lootTargetId when structure store is now empty', () => {
    (Memory as any).rooms = { W1N1: { lootTargetId: 'empty_storage' as any } };
    (Game as any).getObjectById = (id: string) => {
      if (id === 'empty_storage') {
        return { store: { getUsedCapacity: () => 0 } };
      }
      return null;
    };
    const room = makeRoom([]);
    cleanupClaimedRoom(room);
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
  });

  it('removes all foreign construction sites (any type, incl. roads)', () => {
    const roadSite = makeSite({ structureType: STRUCTURE_ROAD, x: 21, y: 26 });
    const terminalSite = makeSite({ structureType: STRUCTURE_TERMINAL, x: 17, y: 27 });
    const room = makeRoom([], [], {}, [roadSite, terminalSite]);
    cleanupClaimedRoom(room);
    expect(roadSite.remove).toHaveBeenCalled();
    expect(terminalSite.remove).toHaveBeenCalled();
  });

  it('is a no-op for non-owned rooms', () => {
    const ext = makeStructure({
      structureType: STRUCTURE_EXTENSION,
      store: { getUsedCapacity: () => 0 },
    });
    const room = mockRoom({
      name: 'W2N2',
      controller: { my: false, level: 0 },
      find: vi.fn(() => [ext]),
    });
    (Memory as any).rooms = { W2N2: {} };
    cleanupClaimedRoom(room);
    expect(ext.destroy).not.toHaveBeenCalled();
  });
});
