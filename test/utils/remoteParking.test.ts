import { pickRemoteParkingTile } from '../../src/utils/remoteParking';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

/** Open 50x50 room except the listed wall tiles, with the given structures. */
const room = (walls: [number, number][], structures: { x: number; y: number; type: string }[]) => {
  const wallSet = new Set(walls.map(([x, y]) => `${x},${y}`));
  return mockRoom({
    name: 'W2N1',
    getTerrain: () => ({ get: (x: number, y: number) => (wallSet.has(`${x},${y}`) ? 1 : 0) }),
    find: vi.fn(() => structures.map((s) => ({ structureType: s.type, pos: { x: s.x, y: s.y } }))),
  });
};

describe('pickRemoteParkingTile', () => {
  beforeEach(() => resetGameGlobals());

  it('never picks a road tile', () => {
    const roads = [];
    for (let x = 10; x <= 30; x++) roads.push({ x, y: 22, type: 'road' });
    const r = room([], roads);
    for (let i = 0; i < 30; i++) {
      const t = pickRemoteParkingTile(r, { x: 20, y: 20 }, `h${i}`)!;
      expect(t.y === 22 && t.x >= 10 && t.x <= 30).toBe(false);
    }
  });

  it('never picks a corridor tile', () => {
    // A 1-wide corridor at x=20,y=1..5 inside walls, source just south of it.
    const walls: [number, number][] = [];
    for (let y = 1; y <= 5; y++) {
      walls.push([19, y], [21, y]);
    }
    const r = room(walls, []);
    for (let i = 0; i < 30; i++) {
      const t = pickRemoteParkingTile(r, { x: 20, y: 7 }, `h${i}`)!;
      expect(t.x === 20 && t.y <= 5).toBe(false);
    }
  });

  it('stays within range 2-5 of the source', () => {
    const r = room([], []);
    for (let i = 0; i < 30; i++) {
      const t = pickRemoteParkingTile(r, { x: 20, y: 20 }, `h${i}`)!;
      const range = Math.max(Math.abs(t.x - 20), Math.abs(t.y - 20));
      expect(range).toBeGreaterThanOrEqual(2);
      expect(range).toBeLessThanOrEqual(5);
    }
  });

  it('is deterministic per name and spreads different names', () => {
    const r = room([], []);
    expect(pickRemoteParkingTile(r, { x: 20, y: 20 }, 'a')).toEqual(
      pickRemoteParkingTile(r, { x: 20, y: 20 }, 'a'),
    );
    const tiles = new Set(
      Array.from({ length: 8 }, (_, i) => {
        const t = pickRemoteParkingTile(r, { x: 20, y: 20 }, `hauler${i}`)!;
        return `${t.x},${t.y}`;
      }),
    );
    expect(tiles.size).toBeGreaterThan(4);
  });

  it('returns undefined when nothing qualifies', () => {
    const walls: [number, number][] = [];
    for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) walls.push([x, y]);
    expect(pickRemoteParkingTile(room(walls, []), { x: 20, y: 20 }, 'a')).toBeUndefined();
  });
});
