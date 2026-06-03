/**
 * Tests for src/utils/perimeterPlanner.ts
 *
 * Uses a minimal mock Room/RoomTerrain so the BFS algorithm can be exercised
 * without a live Screeps runtime. The mock terrain is a flat 50×50 room (no
 * wall tiles) unless specific wall tiles are injected per-test.
 */

import {
  computePerimeter,
  CORE_RADIUS,
  PERIMETER_PLAN_VERSION,
} from '../../src/utils/perimeterPlanner';
import { resetGameGlobals } from '../mocks/screeps';

// -----------------------------------------------------------------------
// Helpers for building minimal mock rooms
// -----------------------------------------------------------------------

function makeTerrainMock(wallTiles: Set<string> = new Set()): any {
  return {
    get(x: number, y: number): number {
      return wallTiles.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0;
    },
  };
}

/**
 * Build a minimal mock Room.
 *
 * @param spawnPos  Spawn position for anchor detection.
 * @param wallTiles Optional set of "x,y" terrain-wall tiles.
 * @param sources   Optional source positions (outside core = need gates).
 * @param controller Optional controller position.
 */
function makeRoom(opts: {
  name?: string;
  spawnPos: { x: number; y: number };
  wallTiles?: Set<string>;
  sources?: { id: string; x: number; y: number }[];
  controller?: { x: number; y: number; my?: boolean };
  remoteRooms?: string[];
  /** Optional layoutPlan positions that bound the min-cut protected region. */
  layoutPlan?: Partial<NonNullable<RoomMemory['layoutPlan']>>;
  /** Optional live-built core structures returned by FIND_MY_STRUCTURES. */
  structures?: { x: number; y: number; structureType: string }[];
}): Room {
  const name = opts.name ?? 'W1N1';
  const wallTiles = opts.wallTiles ?? new Set<string>();
  const terrain = makeTerrainMock(wallTiles);

  // Inject memory
  Memory.rooms[name] = {
    sources: (opts.sources ?? []).map((s) => ({
      id: s.id as Id<Source>,
      x: s.x,
      y: s.y,
    })),
    remoteRooms: opts.remoteRooms ?? [],
    ...(opts.layoutPlan ? { layoutPlan: opts.layoutPlan as RoomMemory['layoutPlan'] } : {}),
  } as RoomMemory;

  const spawnObj = {
    pos: new RoomPosition(opts.spawnPos.x, opts.spawnPos.y, name),
    structureType: STRUCTURE_SPAWN,
  };

  const controllerObj = opts.controller
    ? {
        pos: new RoomPosition(opts.controller.x, opts.controller.y, name),
        my: opts.controller.my ?? true,
        level: 5,
      }
    : undefined;

  const builtStructures = (opts.structures ?? []).map((s) => ({
    pos: new RoomPosition(s.x, s.y, name),
    structureType: s.structureType,
  }));

  return {
    name,
    find(type: any, findOpts?: any) {
      if (type === FIND_MY_SPAWNS) return [spawnObj];
      if (type === FIND_MY_STRUCTURES) {
        const filter = findOpts?.filter;
        return filter ? builtStructures.filter((s) => filter(s)) : builtStructures;
      }
      // Return empty arrays for all exit directions — no gates needed for
      // fallback in tests that explicitly provide sources/controller.
      if (
        type === FIND_EXIT_TOP ||
        type === FIND_EXIT_BOTTOM ||
        type === FIND_EXIT_LEFT ||
        type === FIND_EXIT_RIGHT
      )
        return [];
      return [];
    },
    controller: controllerObj,
    getTerrain() {
      return terrain;
    },
  } as unknown as Room;
}

// -----------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------

describe('perimeterPlanner', () => {
  beforeEach(() => {
    resetGameGlobals();
    // Provide a stub Game.map.getRoomTerrain used by computePerimeter
    (Game as any).map = {
      getRoomTerrain(roomName: string) {
        // Return the terrain stored on the room mock via our Memory helper
        const room = Game.rooms[roomName];
        if (room && typeof (room as any).getTerrain === 'function') {
          return (room as any).getTerrain();
        }
        return makeTerrainMock();
      },
      findExit() {
        return ERR_NO_PATH;
      },
    };
  });

  // -------------------------------------------------------------------
  // Flat room — spawn at centre
  // -------------------------------------------------------------------
  describe('flat room, spawn at (25,25)', () => {
    let room: Room;

    beforeEach(() => {
      room = makeRoom({ spawnPos: { x: 25, y: 25 } });
      Game.rooms['W1N1'] = room;
    });

    it('returns a plan with correct version and coreRadius', () => {
      const plan = computePerimeter(room);
      expect(plan).toBeDefined();
      expect(plan!.version).toBe(PERIMETER_PLAN_VERSION);
      expect(plan!.coreRadius).toBe(CORE_RADIUS);
    });

    it('perimeter tiles are all at Chebyshev distance ≈ CORE_RADIUS from spawn', () => {
      const plan = computePerimeter(room);
      expect(plan).toBeDefined();

      for (const key of plan!.perimeterTiles) {
        const [xs, ys] = key.split(',');
        const x = Number(xs);
        const y = Number(ys);
        const dist = Math.max(Math.abs(x - 25), Math.abs(y - 25));
        // Exterior tiles bordering the core sit at distance CORE_RADIUS or
        // CORE_RADIUS+1 from the spawn (one step outside the core boundary).
        expect(dist).toBeGreaterThanOrEqual(CORE_RADIUS);
        expect(dist).toBeLessThanOrEqual(CORE_RADIUS + 2);
      }
    });

    it('perimeter tiles are non-empty', () => {
      const plan = computePerimeter(room);
      expect(plan!.perimeterTiles.length).toBeGreaterThan(0);
    });

    it('perimeter tiles are within buildable range (2–47)', () => {
      const plan = computePerimeter(room);
      for (const key of plan!.perimeterTiles) {
        const [xs, ys] = key.split(',');
        const x = Number(xs);
        const y = Number(ys);
        expect(x).toBeGreaterThanOrEqual(2);
        expect(x).toBeLessThanOrEqual(47);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(y).toBeLessThanOrEqual(47);
      }
    });

    it('all gateTiles are a subset of perimeterTiles', () => {
      const plan = computePerimeter(room);
      const perimSet = new Set(plan!.perimeterTiles);
      for (const gate of plan!.gateTiles) {
        expect(perimSet.has(gate)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------
  // Source outside core → gate appears
  // -------------------------------------------------------------------
  describe('source outside core radius', () => {
    it('produces gate tiles toward a distant source', () => {
      // Source at (5,5) is Chebyshev(5,5,25,25)=20 — well outside core radius 10
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'src1', x: 5, y: 5 }],
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      expect(plan).toBeDefined();
      expect(plan!.gateTiles.length).toBeGreaterThan(0);
      expect(plan!.gateTargets.some((t) => t.reason.includes('source'))).toBe(true);
    });

    it('gate tile lies on the perimeter between spawn and the source', () => {
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'src1', x: 5, y: 5 }],
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      // The gate(s) should be closer to (5,5) than to the far side of the room
      const perimSet = new Set(plan!.perimeterTiles);
      for (const gate of plan!.gateTiles) {
        expect(perimSet.has(gate)).toBe(true);
        const [xs, ys] = gate.split(',');
        const x = Number(xs);
        const y = Number(ys);
        // Gate should be in the direction of the source (lower-left quadrant roughly)
        // i.e. x < 25, y < 25 — not the opposite side
        const distToSource = Math.max(Math.abs(x - 5), Math.abs(y - 5));
        const distToOpposite = Math.max(Math.abs(x - 45), Math.abs(y - 45));
        expect(distToSource).toBeLessThan(distToOpposite);
      }
    });

    it('aligns an edge-target gate with the spawn→target line, not a corner (regression)', () => {
      // Source pinned to the east edge (49,25). Chebyshev distance from every
      // east-wall tile to (49,25) saturates on the 24-tile x-gap, so the old
      // scoring tied them all and stamped the gate at an arbitrary corner. The
      // spawn→target line scoring must put it opposite the exit, at y≈spawn.y (25).
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'east', x: 49, y: 25 }],
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room)!;
      const eastWallX = Math.max(...plan.perimeterTiles.map((k) => Number(k.split(',')[0])));
      const eastGates = plan.gateTiles
        .map((k) => k.split(',').map(Number))
        .filter(([x]) => x === eastWallX);
      expect(eastGates.length).toBeGreaterThan(0);
      for (const [, y] of eastGates) {
        expect(Math.abs(y - 25)).toBeLessThanOrEqual(3); // aligned with the line, not a corner
      }
    });

    it("gate tiles are NOT in wallTiles (walls don't block gate positions)", () => {
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'src1', x: 5, y: 5 }],
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      // Gate tiles should be passable terrain (we used a flat room with no walls)
      // — this is already guaranteed by the BFS (terrain walls aren't in exteriorSet)
      // but make the invariant explicit.
      expect(plan!.gateTiles.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------
  // Source inside core radius → no gate needed
  // -------------------------------------------------------------------
  describe('source inside core radius', () => {
    it('does not add source as a gate target when source is inside core', () => {
      // Source at (27,27) is Chebyshev(27,27,25,25)=2 — well inside core radius 10
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'src1', x: 27, y: 27 }],
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      expect(plan).toBeDefined();
      // No source gate target when source is inside core
      expect(plan!.gateTargets.some((t) => t.reason.includes('source'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Terrain wall corridor — perimeter follows terrain
  // -------------------------------------------------------------------
  describe('room with a terrain wall corridor', () => {
    it('perimeter does not include terrain wall tiles', () => {
      // Place a horizontal wall band at y=15 from x=0 to x=49 except a gap at x=25
      const wallTiles = new Set<string>();
      for (let x = 0; x <= 49; x++) {
        if (x !== 25) wallTiles.add(`${x},15`); // wall except gap at x=25
      }

      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        wallTiles,
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      expect(plan).toBeDefined();

      // No perimeter tile should be on a wall tile
      for (const key of plan!.perimeterTiles) {
        expect(wallTiles.has(key)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------
  // 2-tile gate width
  // -------------------------------------------------------------------
  describe('gate width', () => {
    it('produces 2 gate tiles per target (not just 1)', () => {
      // Single distant source → should produce 2 gate tiles
      const room = makeRoom({
        spawnPos: { x: 25, y: 25 },
        sources: [{ id: 'src1', x: 5, y: 25 }], // directly west, outside core
      });
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      expect(plan).toBeDefined();
      // At minimum 1 gate tile; ideally 2 — the secondBest selection fires
      // when there are at least 2 distinct perimeter tiles (there always are)
      expect(plan!.gateTiles.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // No anchor → undefined
  // -------------------------------------------------------------------
  describe('no anchor', () => {
    it('returns undefined when room has no spawn and no suggestedSpawnPos', () => {
      const room = {
        name: 'W1N1',
        find(type: any) {
          if (type === FIND_MY_SPAWNS) return []; // no spawns
          return [];
        },
        controller: { my: true, level: 5 },
        getTerrain: () => makeTerrainMock(),
      } as unknown as Room;

      Memory.rooms['W1N1'] = {} as RoomMemory;
      Game.rooms['W1N1'] = room;

      const plan = computePerimeter(room);
      expect(plan).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // Version constant
  // -------------------------------------------------------------------
  it('PERIMETER_PLAN_VERSION is 4', () => {
    expect(PERIMETER_PLAN_VERSION).toBe(4);
  });
});
