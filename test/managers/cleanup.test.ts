/**
 * Tests for cleanupClaimedRoom (construction.ts) and looterNeeded (spawner.ts).
 */
import '../mocks/screeps';
import { cleanupClaimedRoom } from '../../src/managers/construction';
import { looterNeeded, buildLooterBody } from '../../src/managers/spawner';
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
    // A lab/extension/etc. is NOT a loot type: its small store is not worth a
    // looter trip and it occupies an RCL slot, so it must be destroyed.
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

  it('destroys a foreign storage holding less than the loot threshold (not worth a looter)', () => {
    const storage = makeStructure({
      structureType: STRUCTURE_STORAGE,
      id: 'small_storage' as any,
      store: { getUsedCapacity: () => 5_000 }, // below LOOT_MIN_STORE (10k)
    });
    const room = makeRoom([storage]);
    cleanupClaimedRoom(room);
    expect(storage.destroy).toHaveBeenCalled();
    expect((Memory.rooms as any).W1N1.lootTargetId).toBeUndefined();
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

// ---------------------------------------------------------------------------
// looterNeeded — spawn-gate predicate tests
// ---------------------------------------------------------------------------

describe('looterNeeded', () => {
  function makeGatedRoom(
    overrides: {
      rcl?: number;
      storageEnergy?: number;
      hasMy?: boolean;
      lootTargetId?: string;
      lootTargetUsed?: number;
      haulerCount?: number;
      looterCount?: number;
    } = {},
  ): any {
    const {
      rcl = 4,
      hasMy = true,
      lootTargetId = 'loot1',
      lootTargetUsed = 607_371,
      haulerCount = 2,
      looterCount = 0,
    } = overrides;

    // Populate game creeps for countCreepsByRole
    const creeps: Record<string, any> = {};
    for (let i = 0; i < haulerCount; i++) {
      creeps[`hauler_W1N1_${i}`] = {
        memory: { role: 'hauler', homeRoom: 'W1N1' },
        room: { name: 'W1N1' },
      };
    }
    for (let i = 0; i < looterCount; i++) {
      creeps[`looter_W1N1_${i}`] = {
        memory: { role: 'looter', homeRoom: 'W1N1' },
        room: { name: 'W1N1' },
      };
    }
    (Game as any).creeps = creeps;

    // Set up getObjectById to resolve loot target
    (Game as any).getObjectById = (id: string) => {
      if (id === lootTargetId) {
        return { store: { getUsedCapacity: () => lootTargetUsed } };
      }
      return null;
    };

    (Memory as any).rooms = {
      W1N1: lootTargetId ? { lootTargetId } : {},
    };

    const storage = hasMy
      ? { my: true, store: { getUsedCapacity: () => 50_000, getFreeCapacity: () => 950_000 } }
      : undefined;

    return mockRoom({
      name: 'W1N1',
      controller: {
        my: true,
        level: rcl,
        pos: new (globalThis as any).RoomPosition(30, 30, 'W1N1'),
      },
      storage,
    });
  }

  it('returns true when all 5 conditions met (the happy path)', () => {
    const room = makeGatedRoom();
    expect(looterNeeded(room)).toBe(true);
  });

  it('returns false when RCL < 4', () => {
    const room = makeGatedRoom({ rcl: 3 });
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns TRUE when we have no own storage yet (foreign storage occupies the slot)', () => {
    // The whole point of looting: the foreign storage blocks our own storage,
    // so we must NOT gate on having our own storage first (that would deadlock).
    const room = makeGatedRoom({ hasMy: false });
    expect(looterNeeded(room)).toBe(true);
  });

  it('returns false when no lootTargetId in memory', () => {
    const room = makeGatedRoom({ lootTargetId: '' });
    // Empty string falsy → lootTargetId not set
    (Memory as any).rooms.W1N1 = {};
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns false when loot target is gone (getObjectById returns null)', () => {
    const room = makeGatedRoom({ lootTargetUsed: 0 });
    // Override getObjectById to return null
    (Game as any).getObjectById = () => null;
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns false when loot target store is 0 (already looted)', () => {
    const room = makeGatedRoom({ lootTargetUsed: 0 });
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns false when fewer than 2 haulers present', () => {
    const room = makeGatedRoom({ haulerCount: 1 });
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns false when a looter already exists', () => {
    const room = makeGatedRoom({ looterCount: 1 });
    expect(looterNeeded(room)).toBe(false);
  });

  it('returns false when room is not owned by us', () => {
    const room = makeGatedRoom();
    room.controller.my = false;
    expect(looterNeeded(room)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildLooterBody
// ---------------------------------------------------------------------------

describe('buildLooterBody', () => {
  it('returns empty body when energy is too low', () => {
    expect(buildLooterBody(100)).toEqual([]);
  });

  it('scales with energy capacity (300 → 2 WORK + 2 MOVE)', () => {
    const body = buildLooterBody(300);
    expect(body.filter((p) => p === WORK).length).toBe(2);
    expect(body.filter((p) => p === MOVE).length).toBe(2);
  });

  it('caps at 5 WORK + 5 MOVE regardless of high energy', () => {
    const body = buildLooterBody(10_000);
    expect(body.filter((p) => p === WORK).length).toBe(5);
    expect(body.filter((p) => p === MOVE).length).toBe(5);
    expect(body.length).toBe(10);
  });

  it('produces exactly 150e worth at 150e capacity (1 WORK + 1 MOVE)', () => {
    const body = buildLooterBody(150);
    expect(body).toEqual([WORK, MOVE]);
  });
});
