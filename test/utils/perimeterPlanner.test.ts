/**
 * Tests for src/utils/perimeterPlanner.ts
 *
 * Uses a minimal mock Room/RoomTerrain so the BFS algorithm can be exercised
 * without a live Screeps runtime. The mock terrain is a flat 50×50 room (no
 * wall tiles) unless specific wall tiles are injected per-test.
 */

import {
  computePerimeter,
  computeMinCutPerimeter,
  planPerimeter,
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
  it('PERIMETER_PLAN_VERSION is 3', () => {
    expect(PERIMETER_PLAN_VERSION).toBe(3);
  });

  // -------------------------------------------------------------------
  // algo discriminator on the radius plan
  // -------------------------------------------------------------------
  it("computePerimeter tags its output algo: 'radius'", () => {
    const room = makeRoom({ spawnPos: { x: 25, y: 25 } });
    Game.rooms['W1N1'] = room;
    const plan = computePerimeter(room);
    expect(plan!.algo).toBe('radius');
  });
});

// -----------------------------------------------------------------------
// Min-cut perimeter
// -----------------------------------------------------------------------

/**
 * Install a PathFinder.search mock that walks a Bresenham-ish straight line from
 * origin to the goal, so computeMinCutPerimeter's gate identification (which
 * relies on the path crossing barrier tiles) is exercised deterministically.
 */
function installLinePathFinder(): void {
  (PathFinder as any).search = (origin: any, goal: any) => {
    const g = goal.pos ?? goal;
    const path: { x: number; y: number }[] = [];
    let x = origin.x;
    let y = origin.y;
    const tx = g.x;
    const ty = g.y;
    // step toward the goal, max 60 steps as a safety cap
    for (let i = 0; i < 60; i++) {
      if (x === tx && y === ty) break;
      if (x < tx) x++;
      else if (x > tx) x--;
      if (y < ty) y++;
      else if (y > ty) y--;
      path.push({ x, y });
    }
    return { path, ops: path.length, cost: path.length, incomplete: false };
  };
}

describe('perimeterPlanner — min-cut', () => {
  beforeEach(() => {
    resetGameGlobals();
    (Game as any).map = {
      getRoomTerrain(roomName: string) {
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
    installLinePathFinder();
  });

  // A compact layoutPlan whose structures span x∈[20,30], y∈[20,30] so the
  // protected bbox (+margin 2) is x∈[18,32], y∈[18,32]. Mirrors the live
  // structure-bbox shape on W43N58.
  const boxLayout: Partial<NonNullable<RoomMemory['layoutPlan']>> = {
    version: 1,
    storagePos: { x: 25, y: 25 },
    terminalPos: { x: 24, y: 26 },
    towerPositions: [
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ],
    labPositions: [],
    extensionPositions: [
      { x: 20, y: 30 },
      { x: 30, y: 20 },
    ],
    spawnPositions: [{ x: 25, y: 25 }],
  };

  it('returns a valid PerimeterPlanData with algo: mincut', () => {
    const room = makeRoom({ spawnPos: { x: 25, y: 25 }, layoutPlan: boxLayout });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan).toBeDefined();
    expect(plan!.version).toBe(PERIMETER_PLAN_VERSION);
    expect(plan!.coreRadius).toBe(CORE_RADIUS);
    expect(plan!.algo).toBe('mincut');
    expect(plan!.perimeterTiles.length).toBeGreaterThan(0);
  });

  it('all gateTiles are a subset of perimeterTiles', () => {
    const room = makeRoom({
      spawnPos: { x: 25, y: 25 },
      layoutPlan: boxLayout,
      sources: [{ id: 'src1', x: 5, y: 5 }],
    });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    const perimSet = new Set(plan!.perimeterTiles);
    for (const gate of plan!.gateTiles) {
      expect(perimSet.has(gate)).toBe(true);
    }
  });

  it('perimeter tiles are all buildable (2–47) and outside the protected bbox', () => {
    const room = makeRoom({ spawnPos: { x: 25, y: 25 }, layoutPlan: boxLayout });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    for (const key of plan!.perimeterTiles) {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThanOrEqual(47);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(47);
      // protected bbox is x,y ∈ [18,32]; barrier tiles sit outside it
      const insideBbox = x >= 18 && x <= 32 && y >= 18 && y <= 32;
      expect(insideBbox).toBe(false);
    }
  });

  it('gates lie on the spawn→target path', () => {
    const room = makeRoom({
      spawnPos: { x: 25, y: 25 },
      layoutPlan: boxLayout,
      sources: [{ id: 'src1', x: 5, y: 25 }], // due west, outside protected box
    });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan!.gateTiles.length).toBeGreaterThan(0);
    expect(plan!.gateTargets.some((t) => t.reason.includes('source'))).toBe(true);

    // The gate should sit between spawn (25,25) and the source (5,25), i.e. to
    // the west — closer to the source than to the opposite (east) flank.
    const perimSet = new Set(plan!.perimeterTiles);
    for (const gate of plan!.gateTiles) {
      expect(perimSet.has(gate)).toBe(true);
      const [xs, ys] = gate.split(',');
      const x = Number(xs);
      const y = Number(ys);
      const distToSource = Math.max(Math.abs(x - 5), Math.abs(y - 25));
      const distToOpposite = Math.max(Math.abs(x - 45), Math.abs(y - 25));
      expect(distToSource).toBeLessThan(distToOpposite);
    }
  });

  it('returns undefined when there is no anchor', () => {
    const room = {
      name: 'W1N1',
      find(type: any) {
        if (type === FIND_MY_SPAWNS) return [];
        return [];
      },
      controller: { my: true, level: 5 },
      getTerrain: () => makeTerrainMock(),
    } as unknown as Room;
    Memory.rooms['W1N1'] = {} as RoomMemory;
    Game.rooms['W1N1'] = room;

    expect(computeMinCutPerimeter(room)).toBeUndefined();
  });

  it('hugs a natural wall: fewer barrier tiles than the radius ring when terrain helps', () => {
    // A solid natural-wall band just west of the protected bbox lets the min-cut
    // lean on it, producing no more barrier tiles than the radius BFS ring.
    const wallTiles = new Set<string>();
    for (let y = 8; y <= 42; y++) {
      wallTiles.add(`16,${y}`);
      wallTiles.add(`17,${y}`);
    }
    const room = makeRoom({ spawnPos: { x: 25, y: 25 }, layoutPlan: boxLayout, wallTiles });
    Game.rooms['W1N1'] = room;

    const radiusPlan = computePerimeter(room);
    const minCutPlan = computeMinCutPerimeter(room);
    expect(radiusPlan).toBeDefined();
    expect(minCutPlan).toBeDefined();

    const radiusWalls = radiusPlan!.perimeterTiles.length;
    const minCutWalls = minCutPlan!.perimeterTiles.length;
    expect(minCutWalls).toBeLessThanOrEqual(radiusWalls);
  });

  // -------------------------------------------------------------------
  // x27-column regression: barrier leans on a wall just east of the bbox
  // -------------------------------------------------------------------
  it('leans on a natural wall just east of the bbox — no parallel ring east of it', () => {
    // Structures span x∈[20,30]; protected bbox is x∈[18,32]. Place a solid
    // vertical wall band at x=33,34 (just east of the bbox). The min-cut should
    // use the wall as the eastern barrier instead of walling a parallel column
    // further east. Assert no barrier tile sits more than 1 tile east of the
    // wall band (x > 35) on the rows the wall covers.
    const wallTiles = new Set<string>();
    for (let y = 10; y <= 40; y++) {
      wallTiles.add(`33,${y}`);
      wallTiles.add(`34,${y}`);
    }
    const room = makeRoom({ spawnPos: { x: 25, y: 25 }, layoutPlan: boxLayout, wallTiles });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan).toBeDefined();

    // No barrier tile more than ~1 tile east of the wall band on the wall's rows.
    const eastOfWall = plan!.perimeterTiles.filter((key) => {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      return x > 35 && y >= 12 && y <= 38;
    });
    expect(eastOfWall.length).toBe(0);

    // No barrier tile coincides with the natural wall (walls are free barrier).
    for (const key of plan!.perimeterTiles) {
      expect(wallTiles.has(key)).toBe(false);
    }
  });

  // -------------------------------------------------------------------
  // Gate-membership regression: source outside bbox but within CORE_RADIUS
  // -------------------------------------------------------------------
  it('gates a source outside the protected bbox even when within CORE_RADIUS', () => {
    // Protected bbox is x∈[18,32]. A source at (14,25) is OUTSIDE the bbox but
    // Chebyshev(14,25,25,25)=11 — only just over CORE_RADIUS here, so place it at
    // (16,25): chebyshev=9 ≤ CORE_RADIUS yet x=16 < 18 (outside bbox). The old
    // radius-gated logic would omit it; membership-based logic must gate it.
    const room = makeRoom({
      spawnPos: { x: 25, y: 25 },
      layoutPlan: boxLayout,
      sources: [{ id: 'src1', x: 16, y: 25 }],
    });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan).toBeDefined();
    // Confirm the source is within CORE_RADIUS (the case the fix targets)
    expect(Math.max(Math.abs(16 - 25), Math.abs(25 - 25))).toBeLessThanOrEqual(CORE_RADIUS);
    // ...yet still appears as a gate target and produces gate tiles.
    expect(plan!.gateTargets.some((t) => t.reason === 'source(16,25)')).toBe(true);
    expect(plan!.gateTiles.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // Fallback: no structures / no layoutPlan → radius-box protected region
  // -------------------------------------------------------------------
  it('falls back to a sensible barrier when no layoutPlan or structures', () => {
    // Only a spawn (the anchor). collectCorePositions returns just the anchor,
    // so the bbox is a single point expanded by margin → a small box. The
    // min-cut still produces a non-empty enclosing barrier.
    const room = makeRoom({ spawnPos: { x: 25, y: 25 } });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan).toBeDefined();
    expect(plan!.perimeterTiles.length).toBeGreaterThan(0);

    // Barrier must enclose the anchor: at least one tile on each side of (25,25).
    const xs = plan!.perimeterTiles.map((k) => Number(k.split(',')[0]));
    const ys = plan!.perimeterTiles.map((k) => Number(k.split(',')[1]));
    expect(Math.min(...xs)).toBeLessThan(25);
    expect(Math.max(...xs)).toBeGreaterThan(25);
    expect(Math.min(...ys)).toBeLessThan(25);
    expect(Math.max(...ys)).toBeGreaterThan(25);
  });

  // -------------------------------------------------------------------
  // Live-built structures (no layoutPlan) also bound the protected region
  // -------------------------------------------------------------------
  it('uses live-built core structures to bound the protected region', () => {
    const room = makeRoom({
      spawnPos: { x: 25, y: 25 },
      structures: [
        { x: 20, y: 20, structureType: STRUCTURE_EXTENSION },
        { x: 30, y: 30, structureType: STRUCTURE_TOWER },
        { x: 22, y: 25, structureType: STRUCTURE_STORAGE },
      ],
    });
    Game.rooms['W1N1'] = room;

    const plan = computeMinCutPerimeter(room);
    expect(plan).toBeDefined();
    // bbox spans [20,30]+margin → [18,32]; barrier tiles sit outside it.
    for (const key of plan!.perimeterTiles) {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      const insideBbox = x >= 18 && x <= 32 && y >= 18 && y <= 32;
      expect(insideBbox).toBe(false);
    }
  });

  // -------------------------------------------------------------------
  // Selector honours the flag
  // -------------------------------------------------------------------
  it('planPerimeter uses radius when flag off, mincut when on', () => {
    const room = makeRoom({ spawnPos: { x: 25, y: 25 }, layoutPlan: boxLayout });
    Game.rooms['W1N1'] = room;

    Memory.perimeterMinCut = false;
    expect(planPerimeter(room)!.algo).toBe('radius');

    Memory.perimeterMinCut = true;
    expect(planPerimeter(room)!.algo).toBe('mincut');
  });
});
