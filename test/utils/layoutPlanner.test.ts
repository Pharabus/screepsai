import { computeLayout, LAB_STAMP, EXTENSION_STAMP } from '../../src/utils/layoutPlanner';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function makeTerrain(walls: Set<string> = new Set()): any {
  return {
    get: (x: number, y: number) => (walls.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0),
  };
}

function makeRoom(overrides: Record<string, any> = {}): any {
  const spawn = { pos: new RoomPosition(25, 25, 'W1N1'), id: 'spawn1' };
  const terrain = overrides.terrain ?? makeTerrain();
  const room = mockRoom({
    name: 'W1N1',
    controller: { my: true, level: 2 },
    ...overrides,
  });
  room.find = (type: number) => {
    if (type === FIND_MY_SPAWNS) return [spawn];
    if (type === FIND_STRUCTURES) return [];
    return [];
  };
  room.getTerrain = () => terrain;
  return room;
}

beforeEach(() => {
  resetGameGlobals();
});

describe('computeLayout', () => {
  it('returns undefined when no spawn exists', () => {
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 2 } });
    room.find = () => [];
    room.getTerrain = () => makeTerrain();
    expect(computeLayout(room)).toBeUndefined();
  });

  it('returns a plan with all required fields', () => {
    const room = makeRoom();
    const plan = computeLayout(room);
    expect(plan).toBeDefined();
    expect(plan).toHaveProperty('storagePos');
    expect(plan).toHaveProperty('terminalPos');
    expect(plan).toHaveProperty('towerPositions');
    expect(plan).toHaveProperty('labPositions');
    expect(plan).toHaveProperty('extensionPositions');
  });

  it('uses existing storage position when storage is present', () => {
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    expect(plan.storagePos).toEqual({ x: 28, y: 25 });
  });

  it('lab positions are at storagePos + (2,2) + LAB_STAMP offsets', () => {
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const ax = 28 + 2; // 30
    const ay = 25 + 2; // 27
    // Every lab position should correspond to a LAB_STAMP entry
    for (const labPos of plan.labPositions) {
      const dx = labPos.x - ax;
      const dy = labPos.y - ay;
      const inStamp = LAB_STAMP.some(([sdx, sdy]) => sdx === dx && sdy === dy);
      expect(inStamp).toBe(true);
    }
  });

  it('extension positions do not overlap with lab positions', () => {
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const labSet = new Set(plan.labPositions.map((p) => `${p.x},${p.y}`));
    for (const ext of plan.extensionPositions) {
      expect(labSet.has(`${ext.x},${ext.y}`)).toBe(false);
    }
  });

  it('extension positions do not overlap with terminal position', () => {
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const termKey = `${plan.terminalPos.x},${plan.terminalPos.y}`;
    const extSet = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));
    expect(extSet.has(termKey)).toBe(false);
  });

  it('all positions are within room bounds [2..47]', () => {
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const allPositions = [
      plan.storagePos,
      plan.terminalPos,
      ...plan.towerPositions,
      ...plan.labPositions,
      ...plan.extensionPositions,
    ];
    for (const { x, y } of allPositions) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThanOrEqual(47);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThanOrEqual(47);
    }
  });

  it('skips wall tiles for extension positions', () => {
    const spawn = new RoomPosition(25, 25, 'W1N1');
    // Wall at first stamp position (-1, -2) relative to spawn
    const wallPos = `${spawn.x - 1},${spawn.y - 2}`;
    const room = makeRoom({ terrain: makeTerrain(new Set([wallPos])) });
    const plan = computeLayout(room)!;
    const extSet = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));
    expect(extSet.has(wallPos)).toBe(false);
  });

  it('produces up to 6 tower positions', () => {
    const room = makeRoom();
    const plan = computeLayout(room)!;
    expect(plan.towerPositions.length).toBeLessThanOrEqual(6);
    expect(plan.towerPositions.length).toBeGreaterThan(0);
  });

  it('tower positions are spread (no two towers in exactly the same spot)', () => {
    const room = makeRoom();
    const plan = computeLayout(room)!;
    const keys = plan.towerPositions.map((p) => `${p.x},${p.y}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('produces at least 40 extension positions for typical terrain', () => {
    // 40 = RCL 6 max. Should always be achievable in open terrain.
    const room = makeRoom({
      storage: { pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    expect(plan.extensionPositions.length).toBeGreaterThanOrEqual(40);
  });
});

describe('EXTENSION_STAMP and LAB_STAMP exports', () => {
  it('EXTENSION_STAMP has 60 entries (RCL 8 max)', () => {
    expect(EXTENSION_STAMP).toHaveLength(60);
  });

  it('LAB_STAMP has 10 entries (RCL 8 max)', () => {
    expect(LAB_STAMP).toHaveLength(10);
  });

  it('EXTENSION_STAMP has no dx=0 or dy=0 entries (corridors kept clear)', () => {
    for (const [dx, dy] of EXTENSION_STAMP) {
      expect(dx === 0 && dy === 0).toBe(false);
      // dx=0 XOR dy=0 would be a corridor tile — ensure neither axis is zero
      // (corridor = entire row/column at dx=0 or dy=0)
      expect(dx === 0 || dy === 0).toBe(false);
    }
  });
});
