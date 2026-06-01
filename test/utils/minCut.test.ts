/**
 * Tests for src/utils/minCut.ts
 *
 * computeMinCut is Screeps-runtime-free: it takes an isWall predicate and a
 * protected Set, so these tests build wall grids and protected rectangles
 * directly without mocking Game/Memory. resetGameGlobals() is still called per
 * the project test convention.
 */

import { computeMinCut } from '../../src/utils/minCut';
import { resetGameGlobals } from '../mocks/screeps';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Build an isWall predicate from a Set of "x,y" wall keys. */
function wallPredicate(walls: Set<string>): (x: number, y: number) => boolean {
  return (x: number, y: number) => walls.has(`${x},${y}`);
}

/** Build a protected Set: a filled rectangle [x0..x1] × [y0..y1]. */
function protectedRect(x0: number, y0: number, x1: number, y1: number): Set<string> {
  const s = new Set<string>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      s.add(`${x},${y}`);
    }
  }
  return s;
}

function keySet(tiles: { x: number; y: number }[]): Set<string> {
  return new Set(tiles.map((t) => `${t.x},${t.y}`));
}

/**
 * Returns true if the protected region is fully sealed: flood-filling from every
 * protected tile, with natural walls AND barrier tiles impassable, never reaches
 * a room-edge tile (x or y in {0,49}). A breach to the edge means the barrier
 * leaks (e.g. a creep slipping around the end of the wall through the x1 lane).
 */
function isSealed(
  isWall: (x: number, y: number) => boolean,
  protectedSet: Set<string>,
  barrier: Set<string>,
): boolean {
  const blocked = (x: number, y: number) => isWall(x, y) || barrier.has(`${x},${y}`);
  const seen = new Set<string>();
  const queue: { x: number; y: number }[] = [];
  for (const k of protectedSet) {
    const c = k.indexOf(',');
    const x = Number(k.slice(0, c));
    const y = Number(k.slice(c + 1));
    if (!blocked(x, y) && !seen.has(k)) {
      seen.add(k);
      queue.push({ x, y });
    }
  }
  const D = [-1, 0, 1, -1, 1, -1, 0, 1];
  const E = [-1, -1, -1, 0, 0, 1, 1, 1];
  let head = 0;
  while (head < queue.length) {
    const { x, y } = queue[head++]!;
    if (x === 0 || x === 49 || y === 0 || y === 49) return false; // reached the edge → leak
    for (let d = 0; d < 8; d++) {
      const nx = x + D[d]!;
      const ny = y + E[d]!;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
      const nk = `${nx},${ny}`;
      if (seen.has(nk) || blocked(nx, ny)) continue;
      seen.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }
  return true;
}

// -----------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------

describe('minCut', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  // -------------------------------------------------------------------
  // Open box — ramparts ring the protected rectangle
  // -------------------------------------------------------------------
  describe('open box (no terrain walls)', () => {
    it('rings the protected rectangle with barrier tiles', () => {
      const noWalls = new Set<string>();
      const prot = protectedRect(20, 20, 29, 29);

      const tiles = computeMinCut({
        isWall: wallPredicate(noWalls),
        protected: prot,
      });

      expect(tiles.length).toBeGreaterThan(0);

      // No barrier tile is itself protected
      const barrier = keySet(tiles);
      for (const t of tiles) {
        expect(prot.has(`${t.x},${t.y}`)).toBe(false);
      }

      // The barrier must fully enclose the protected rect — i.e. it should
      // surround it on all four sides. Verify there is at least one barrier
      // tile beyond each edge of the rectangle.
      const xs = tiles.map((t) => t.x);
      const ys = tiles.map((t) => t.y);
      expect(Math.min(...xs)).toBeLessThan(20); // barrier west of rect
      expect(Math.max(...xs)).toBeGreaterThan(29); // barrier east of rect
      expect(Math.min(...ys)).toBeLessThan(20); // barrier north of rect
      expect(Math.max(...ys)).toBeGreaterThan(29); // barrier south of rect

      // Every barrier tile sits within the buildable range
      for (const t of tiles) {
        expect(t.x).toBeGreaterThanOrEqual(2);
        expect(t.x).toBeLessThanOrEqual(47);
        expect(t.y).toBeGreaterThanOrEqual(2);
        expect(t.y).toBeLessThanOrEqual(47);
      }

      expect(barrier.size).toBe(tiles.length); // no duplicates
    });

    it('the barrier separates the protected core from the room border', () => {
      // Flood-fill from a border tile (0,0) over non-wall, non-barrier tiles.
      // It must NOT reach any protected tile.
      const noWalls = new Set<string>();
      const prot = protectedRect(20, 20, 29, 29);
      const tiles = computeMinCut({ isWall: wallPredicate(noWalls), protected: prot });
      const barrier = keySet(tiles);

      const visited = new Set<string>();
      const queue: { x: number; y: number }[] = [{ x: 0, y: 0 }];
      visited.add('0,0');
      const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
      const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
      let head = 0;
      let reachedProtected = false;
      while (head < queue.length) {
        const c = queue[head++]!;
        for (let d = 0; d < 8; d++) {
          const nx = c.x + DX[d]!;
          const ny = c.y + DY[d]!;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
          const k = `${nx},${ny}`;
          if (visited.has(k)) continue;
          if (barrier.has(k)) continue; // barrier blocks
          if (prot.has(k)) {
            reachedProtected = true;
            continue;
          }
          visited.add(k);
          queue.push({ x: nx, y: ny });
        }
      }
      expect(reachedProtected).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Regression: barrier is a thin ring, NOT a flow-carrying band.
  //
  // A naive "saturated internal edge" extraction returns every tile flow
  // passes through (a thick band from the core out to the border). The correct
  // residual-reachability extraction returns only the genuine cut vertices —
  // the one-tile-thick ring immediately around the protected rect.
  // -------------------------------------------------------------------
  describe('thin-ring extraction (residual min-cut, not saturated band)', () => {
    it('returns exactly the one-tile ring around a small interior rect', () => {
      const noWalls = new Set<string>();
      // Small protected rect well inside an open room so flow passes through many
      // intermediate tiles before reaching the border.
      const prot = protectedRect(23, 23, 26, 26);

      const tiles = computeMinCut({ isWall: wallPredicate(noWalls), protected: prot });
      const barrier = keySet(tiles);

      // The minimal vertex cut around a 4×4 rect is the 8-connected ring of tiles
      // immediately surrounding it: the (x0-1..x1+1) × (y0-1..y1+1) box minus the
      // rect itself.
      const expected = new Set<string>();
      for (let y = 22; y <= 27; y++) {
        for (let x = 22; x <= 27; x++) {
          const k = `${x},${y}`;
          if (!prot.has(k)) expected.add(k);
        }
      }

      // Barrier must equal the ring exactly — no band extending toward the border.
      expect(barrier).toEqual(expected);
      expect(tiles.length).toBe(expected.size);

      // Explicitly assert there is no barrier tile far from the rect (would
      // indicate a flow-carrying band, the bug this test guards against).
      const farTiles = tiles.filter((t) => t.x < 20 || t.x > 29 || t.y < 20 || t.y > 29);
      expect(farTiles.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Single-tile gap in an otherwise solid natural wall
  // -------------------------------------------------------------------
  describe('single gap in a solid natural wall', () => {
    it('places a barrier at exactly the gap, none elsewhere along the wall', () => {
      // Solid vertical wall at x=10 from y=0..49, with a single gap at (10, 25).
      // Protected rect sits to the EAST (x=20..29). The only way through the wall
      // on the west flank is the gap, so the min-cut should be a single tile in
      // that corridor (the gap or an adjacent corridor tile), with zero barrier
      // tiles touching the solid wall line itself.
      const walls = new Set<string>();
      for (let y = 0; y <= 49; y++) {
        if (y !== 25) walls.add(`10,${y}`);
      }
      const prot = protectedRect(20, 20, 29, 29);

      const tiles = computeMinCut({ isWall: wallPredicate(walls), protected: prot });
      const barrier = keySet(tiles);

      // There must be at least one barrier tile sealing the gap corridor near y=25.
      const nearGap = tiles.filter((t) => Math.abs(t.y - 25) <= 1);
      expect(nearGap.length).toBeGreaterThan(0);

      // No barrier tile should coincide with a natural wall tile (walls are free).
      for (const t of tiles) {
        expect(walls.has(`${t.x},${t.y}`)).toBe(false);
      }

      // The west flank above/below the gap is sealed by terrain — there should be
      // no barrier tiles on the far-west column (x<10) away from the gap row,
      // because nothing can flow through the solid wall there.
      const farWestAwayFromGap = tiles.filter((t) => t.x < 10 && Math.abs(t.y - 25) > 2);
      expect(farWestAwayFromGap.length).toBe(0);

      // The barrier separates core from border (flood-fill check).
      const visited = new Set<string>();
      const queue: { x: number; y: number }[] = [{ x: 0, y: 0 }];
      visited.add('0,0');
      const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
      const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
      let head = 0;
      let reachedProtected = false;
      while (head < queue.length) {
        const c = queue[head++]!;
        for (let d = 0; d < 8; d++) {
          const nx = c.x + DX[d]!;
          const ny = c.y + DY[d]!;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
          const k = `${nx},${ny}`;
          if (visited.has(k)) continue;
          if (walls.has(k)) continue; // natural wall blocks
          if (barrier.has(k)) continue; // barrier blocks
          if (prot.has(k)) {
            reachedProtected = true;
            continue;
          }
          visited.add(k);
          queue.push({ x: nx, y: ny });
        }
      }
      expect(reachedProtected).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Fully wall-sealed flank → zero barrier tiles on that side
  // -------------------------------------------------------------------
  describe('fully wall-sealed flank', () => {
    it('places zero barrier tiles along a completely solid wall side', () => {
      // Solid wall completely sealing the west: a vertical wall x=10 y=0..49 with
      // NO gap, plus walls boxing the protected rect on the other three sides too,
      // EXCEPT a single opening on the east. The min-cut only needs to seal the
      // east opening; the solid west wall needs zero ramparts.
      const walls = new Set<string>();
      // West wall — fully solid, no gap
      for (let y = 0; y <= 49; y++) walls.add(`10,${y}`);
      // North wall
      for (let x = 10; x <= 40; x++) walls.add(`${x},10`);
      // South wall
      for (let x = 10; x <= 40; x++) walls.add(`${x},40`);
      // East wall with a 3-tile gap at y=24..26
      for (let y = 10; y <= 40; y++) {
        if (y < 24 || y > 26) walls.add(`40,${y}`);
      }
      const prot = protectedRect(20, 20, 29, 29);

      const tiles = computeMinCut({ isWall: wallPredicate(walls), protected: prot });

      // No barrier tile on the solid west wall column (x=10) or just west of it,
      // because that flank is fully sealed by terrain.
      const westSide = tiles.filter((t) => t.x <= 10);
      expect(westSide.length).toBe(0);

      // The barrier should be concentrated near the east gap (x≈40, y≈24..26).
      const nearEastGap = tiles.filter((t) => t.x >= 30 && t.y >= 22 && t.y <= 28);
      expect(nearEastGap.length).toBeGreaterThan(0);

      // No barrier tile coincides with a natural wall.
      for (const t of tiles) {
        expect(walls.has(`${t.x},${t.y}`)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------
  // Disconnected protected pockets split by terrain — handled, no crash
  // -------------------------------------------------------------------
  describe('disconnected protected pockets', () => {
    it('handles a protected region split by a wall band without crashing', () => {
      // A horizontal wall band at y=25 (full width) splits the room. Two protected
      // pockets, one above (20..24) and one below (26..30) the band.
      const walls = new Set<string>();
      for (let x = 0; x <= 49; x++) walls.add(`${x},25`);

      const prot = new Set<string>();
      for (let y = 20; y <= 24; y++) for (let x = 20; x <= 29; x++) prot.add(`${x},${y}`);
      for (let y = 26; y <= 30; y++) for (let x = 20; x <= 29; x++) prot.add(`${x},${y}`);

      let tiles: { x: number; y: number }[] = [];
      expect(() => {
        tiles = computeMinCut({ isWall: wallPredicate(walls), protected: prot });
      }).not.toThrow();

      // Each pocket must be enclosed: flood-fill from border can't reach either.
      const barrier = keySet(tiles);
      const visited = new Set<string>();
      const queue: { x: number; y: number }[] = [{ x: 0, y: 0 }];
      visited.add('0,0');
      const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
      const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
      let head = 0;
      let reachedProtected = false;
      while (head < queue.length) {
        const c = queue[head++]!;
        for (let d = 0; d < 8; d++) {
          const nx = c.x + DX[d]!;
          const ny = c.y + DY[d]!;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
          const k = `${nx},${ny}`;
          if (visited.has(k)) continue;
          if (walls.has(k)) continue;
          if (barrier.has(k)) continue;
          if (prot.has(k)) {
            reachedProtected = true;
            continue;
          }
          visited.add(k);
          queue.push({ x: nx, y: ny });
        }
      }
      expect(reachedProtected).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Min-cut count ≤ radius-ring count on an exploitable fixture
  // -------------------------------------------------------------------
  describe('terrain efficiency vs a radius ring', () => {
    it('produces no more barrier tiles than a full radius ring on a terrain fixture', () => {
      // Protected rect 20..29 with a big natural-wall band on the west that the
      // min-cut can lean on. A naive radius ring would wall the full perimeter
      // (~ (rect+1) box). The min-cut should be ≤ that count because the western
      // wall band provides a free barrier.
      const radius = 11;
      const cx = 24;
      const cy = 24;

      // A naive radius-ring count: the box of buildable tiles at Chebyshev
      // distance == radius from the centre (the outline). Approximate the radius
      // ring as the perimeter of a (2*radius+1) square.
      const ringCount = 4 * (2 * radius); // perimeter of square side (2r+1) minus corners overlap ~ 8r

      // West wall band: two solid columns at x=8 and x=9 spanning y=10..40.
      const walls = new Set<string>();
      for (let y = 10; y <= 40; y++) {
        walls.add(`8,${y}`);
        walls.add(`9,${y}`);
      }
      const prot = protectedRect(cx - 4, cy - 4, cx + 4, cy + 4);

      const tiles = computeMinCut({ isWall: wallPredicate(walls), protected: prot });

      // Min-cut should never exceed a full radius ring on the same fixture.
      expect(tiles.length).toBeLessThanOrEqual(ringCount);
    });
  });

  // -------------------------------------------------------------------
  // Seal: the barrier must fully enclose the protected region, including
  // when the cut leans on the room edge (regression for the x1/y1 leak —
  // extraction was clamped to 2..47, dropping cut tiles on the buildable
  // edge ring and leaving a 1-tile lane to the border).
  // -------------------------------------------------------------------
  describe('seal (no leak to the room edge)', () => {
    it('fully encloses a protected rect placed near the room edge in open terrain', () => {
      const noWalls = new Set<string>();
      // Rect touches x=2/y=2 (the inner edge of the buildable area, as a clamped
      // bbox can). The only tile between protected x=2 and the x=0 border is x=1,
      // so the min-cut MUST place ramparts on the edge-adjacent ring (x1/y1) to
      // seal it — exactly the tiles the old 2..47 extraction dropped.
      const prot = protectedRect(2, 2, 6, 6);
      const tiles = computeMinCut({ isWall: wallPredicate(noWalls), protected: prot });
      const barrier = keySet(tiles);

      expect(isSealed(wallPredicate(noWalls), prot, barrier)).toBe(true);
      // It genuinely needed the edge ring (would have been dropped under 2..47).
      expect(tiles.some((t) => t.x === 1 || t.y === 1)).toBe(true);
    });

    it('seals a rect that leans on a partial natural wall near the edge', () => {
      // A natural wall stub near the NW corner; the min-cut leans on it but must
      // still close the open lanes around it (including the x1 ring) to seal.
      const walls = new Set<string>();
      for (let y = 0; y <= 8; y++) walls.add(`8,${y}`); // vertical stub x=8, y0..8
      const prot = protectedRect(3, 3, 6, 10);
      const tiles = computeMinCut({ isWall: wallPredicate(walls), protected: prot });
      const barrier = keySet(tiles);

      expect(isSealed(wallPredicate(walls), prot, barrier)).toBe(true);
    });
  });
});
