import {
  computeLayout,
  LAB_STAMP,
  EXTENSION_STAMP,
  scoreSpawnCandidate,
  pruneUnreachableExtensions,
  findStrandedExtensions,
} from '../../src/utils/layoutPlanner';
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
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    expect(plan.storagePos).toEqual({ x: 28, y: 25 });
  });

  it('lab positions are at storagePos + (2,2) + LAB_STAMP offsets', () => {
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
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
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const labSet = new Set(plan.labPositions.map((p) => `${p.x},${p.y}`));
    for (const ext of plan.extensionPositions) {
      expect(labSet.has(`${ext.x},${ext.y}`)).toBe(false);
    }
  });

  it('extension positions do not overlap with terminal position', () => {
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const termKey = `${plan.terminalPos.x},${plan.terminalPos.y}`;
    const extSet = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));
    expect(extSet.has(termKey)).toBe(false);
  });

  it('all positions are within room bounds [2..47]', () => {
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
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

  it('keeps the storage accessible — does not box it in with extensions', () => {
    // Live regression (W44N57): the extension stamp filled all but one neighbour of
    // the storage, deadlocking creeps queueing for the single access tile. The
    // planner must reserve >= STORAGE_ACCESS_MIN (4) walkable neighbours.
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    const sp = plan.storagePos;
    const occupied = new Set<string>([
      `${plan.terminalPos.x},${plan.terminalPos.y}`,
      ...(plan.factoryPos ? [`${plan.factoryPos.x},${plan.factoryPos.y}`] : []),
      ...plan.towerPositions.map((p) => `${p.x},${p.y}`),
      ...plan.labPositions.map((p) => `${p.x},${p.y}`),
      ...plan.extensionPositions.map((p) => `${p.x},${p.y}`),
      ...plan.spawnPositions.map((p) => `${p.x},${p.y}`),
    ]);
    const neighbors: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    const open = neighbors.filter(([dx, dy]) => {
      const x = sp.x + dx;
      const y = sp.y + dy;
      return x >= 2 && x <= 47 && y >= 2 && y <= 47 && !occupied.has(`${x},${y}`);
    });
    expect(open.length).toBeGreaterThanOrEqual(4);
  });

  it('does not over-reserve storage access when fewer than STORAGE_ACCESS_MIN neighbours are open', () => {
    // When terrain walls block most storage neighbours the planner should reserve only
    // the tiles that actually exist — no phantom reservation, no out-of-bounds crash.
    // Storage at (28,25): wall off 6 of 8 neighbours, leaving only (27,24) and (29,25).
    // The extension stamp must not land on those 2 remaining walkable tiles even though
    // there are fewer open tiles than STORAGE_ACCESS_MIN (4). Terminal/factory may
    // legitimately consume one of them — only extensions are gated by the reservation.
    const storagePos = new RoomPosition(28, 25, 'W1N1');
    const walls = new Set<string>([
      '27,25', // left cardinal
      '29,24', // top-right diagonal
      '28,24', // top cardinal
      '28,26', // bottom cardinal
      '27,26', // bottom-left diagonal
      '29,26', // bottom-right diagonal
    ]);
    const room = makeRoom({
      storage: { my: true, pos: storagePos },
      terrain: makeTerrain(walls),
    });
    const plan = computeLayout(room)!;
    const sp = plan.storagePos;
    const allNeighbors: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    // Count how many non-wall neighbours there are (max the planner can reserve)
    const walkableNeighborCount = allNeighbors.filter(([dx, dy]) => {
      const x = sp.x + dx;
      const y = sp.y + dy;
      return x >= 2 && x <= 47 && y >= 2 && y <= 47 && !walls.has(`${x},${y}`);
    }).length;
    // Should be 2 given the walls above
    expect(walkableNeighborCount).toBe(2);
    // The core invariant: extensions must not land on any of the open storage neighbours.
    // (Terminal/factory are allowed there — the reservation targets extensions only.)
    const extSet = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));
    for (const [dx, dy] of allNeighbors) {
      const x = sp.x + dx;
      const y = sp.y + dy;
      if (x < 2 || x > 47 || y < 2 || y > 47) continue;
      if (walls.has(`${x},${y}`)) continue;
      expect(extSet.has(`${x},${y}`)).toBe(false);
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
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    expect(plan.extensionPositions.length).toBeGreaterThanOrEqual(40);
  });

  it('seeds live tower into towerPositions and excludes it from all other plan fields', () => {
    const towerPos = new RoomPosition(28, 25, 'W1N1');
    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_MY_STRUCTURES) {
        const towers = [{ structureType: STRUCTURE_TOWER, pos: towerPos, id: 'tower1' }];
        return opts?.filter ? towers.filter(opts.filter) : towers;
      }
      return [];
    };
    const plan = computeLayout(room)!;
    const towerKey = '28,25';
    // Live tower is now seeded into the plan — it must appear in towerPositions
    expect(plan.towerPositions.map((p) => `${p.x},${p.y}`)).toContain(towerKey);
    // …but must not appear in any other plan field
    expect(plan.labPositions.map((p) => `${p.x},${p.y}`)).not.toContain(towerKey);
    expect(plan.extensionPositions.map((p) => `${p.x},${p.y}`)).not.toContain(towerKey);
    expect(`${plan.storagePos.x},${plan.storagePos.y}`).not.toBe(towerKey);
    expect(`${plan.terminalPos.x},${plan.terminalPos.y}`).not.toBe(towerKey);
  });

  it('W43N58 regression: live towers seeded, additional slots avoid live structures', () => {
    // Exact coordinates from the MCP diagnostic that triggered this fix.
    // Spawn confirmed at (16,31) by team-lead-2 MCP 2026-05-20.
    // With this spawn, all 9 live structures fall inside the range 3-6 ring —
    // towers are in reserved so excluded as candidates but still seeded;
    // roads and extensions are blocked by isTileBuildable for new slots.
    const spawnPos = new RoomPosition(16, 31, 'W1N1');
    const liveTowers = [
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(13, 29, 'W1N1'), id: 'tA' },
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(13, 31, 'W1N1'), id: 'tB' },
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(21, 37, 'W1N1'), id: 'tC' },
    ];
    const otherStructures = [
      { structureType: STRUCTURE_ROAD, pos: new RoomPosition(10, 37, 'W1N1') },
      { structureType: STRUCTURE_ROAD, pos: new RoomPosition(16, 34, 'W1N1') },
      { structureType: STRUCTURE_ROAD, pos: new RoomPosition(19, 30, 'W1N1') },
      { structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(13, 30, 'W1N1') },
      { structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(21, 36, 'W1N1') },
      { structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(18, 28, 'W1N1') },
    ];
    const allStructures = [...liveTowers, ...otherStructures];
    const liveKeys = new Set(allStructures.map((s) => `${s.pos.x},${s.pos.y}`));

    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: spawnPos }];
      if (type === FIND_STRUCTURES)
        return opts?.filter ? allStructures.filter(opts.filter) : allStructures;
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? liveTowers.filter(opts.filter) : liveTowers;
      return [];
    };

    const plan = computeLayout(room)!;
    const towerKeys = plan.towerPositions.map((p) => `${p.x},${p.y}`);

    // All 3 live towers must be the first 3 entries (sorted by id: tA < tB < tC)
    expect(towerKeys.slice(0, 3)).toEqual(['13,29', '13,31', '21,37']);
    expect(plan.towerPositions.length).toBe(6);

    // None of the 3 new slots must land on a live structure tile
    for (const pos of plan.towerPositions.slice(3)) {
      expect(liveKeys.has(`${pos.x},${pos.y}`)).toBe(false);
    }
  });

  it('general regression: 3 live towers seeded; new slots and other fields have zero live-structure collisions', () => {
    const liveTowers = [
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(30, 20, 'W1N1'), id: 'x1' },
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(20, 30, 'W1N1'), id: 'x2' },
      { structureType: STRUCTURE_TOWER, pos: new RoomPosition(30, 30, 'W1N1'), id: 'x3' },
    ];
    // Pack the entire range-3 ring with roads to force new tower slots to range 4+
    const roadRing: { structureType: string; pos: RoomPosition }[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (Math.abs(dx) !== 3 && Math.abs(dy) !== 3) continue;
        roadRing.push({
          structureType: STRUCTURE_ROAD,
          pos: new RoomPosition(25 + dx, 25 + dy, 'W1N1'),
        });
      }
    }
    const allStructures = [...liveTowers, ...roadRing];
    const liveKeys = new Set(allStructures.map((s) => `${s.pos.x},${s.pos.y}`));

    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_STRUCTURES)
        return opts?.filter ? allStructures.filter(opts.filter) : allStructures;
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? liveTowers.filter(opts.filter) : liveTowers;
      return [];
    };

    const plan = computeLayout(room)!;
    const towerKeys = plan.towerPositions.map((p) => `${p.x},${p.y}`);

    // All 3 live towers present
    expect(towerKeys).toContain('30,20');
    expect(towerKeys).toContain('20,30');
    expect(towerKeys).toContain('30,30');

    // New slots (index 3-5) must not collide with any live structure
    for (const pos of plan.towerPositions.slice(3)) {
      expect(liveKeys.has(`${pos.x},${pos.y}`)).toBe(false);
    }

    // No planned tower slot may land on a road
    for (const pos of plan.towerPositions) {
      const live = allStructures.find((s) => `${s.pos.x},${s.pos.y}` === `${pos.x},${pos.y}`);
      if (live) expect(live.structureType).toBe(STRUCTURE_TOWER);
    }
  });

  it('truncates towerPositions to 6 when more than 6 live towers exist (no crash)', () => {
    const liveTowers = Array.from({ length: 7 }, (_, i) => ({
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(20 + i * 2, 30, 'W1N1'),
      id: `t${i}`,
    }));
    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_STRUCTURES)
        return opts?.filter ? liveTowers.filter(opts.filter) : liveTowers;
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? liveTowers.filter(opts.filter) : liveTowers;
      return [];
    };
    const plan = computeLayout(room)!;
    expect(plan.towerPositions.length).toBe(6);
  });

  it('tower CS is seeded; extension CS on the same tile blocks that tile as a new tower slot', () => {
    // Tower CS at (28,22) — range-3 corner from spawn (25,25). Should be seeded.
    // Extension CS at (24,23) — stamp position [-1,-2]. Blocks (24,23) for tower picking.
    const towerCs = {
      structureType: STRUCTURE_TOWER,
      pos: new RoomPosition(28, 22, 'W1N1'),
      id: 'cs_tower',
    };
    const extensionCs = {
      structureType: STRUCTURE_EXTENSION,
      pos: new RoomPosition(24, 23, 'W1N1'),
      id: 'cs_ext',
    };
    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_MY_CONSTRUCTION_SITES) {
        const sites = [towerCs, extensionCs];
        return opts?.filter ? sites.filter(opts.filter) : sites;
      }
      return [];
    };
    const plan = computeLayout(room)!;
    const towerKeys = plan.towerPositions.map((p) => `${p.x},${p.y}`);
    // Tower CS tile is seeded into the plan
    expect(towerKeys).toContain('28,22');
    // Extension CS tile must not appear as a new tower slot
    expect(towerKeys).not.toContain('24,23');
  });

  it('spawnPositions has 3 entries for a greenfield room', () => {
    const room = makeRoom();
    const plan = computeLayout(room)!;
    expect(plan.spawnPositions.length).toBe(3);
  });

  it('spawnPositions[0] is the live spawn and no other plan field uses that tile', () => {
    const liveSpawn = {
      structureType: STRUCTURE_SPAWN,
      pos: new RoomPosition(16, 31, 'W1N1'),
      id: 's1',
    };
    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [liveSpawn];
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? [liveSpawn].filter(opts.filter) : [liveSpawn];
      return [];
    };
    const plan = computeLayout(room)!;
    expect(plan.spawnPositions[0]).toEqual({ x: 16, y: 31 });
    expect(plan.spawnPositions.length).toBe(3);
    const spawnKey = '16,31';
    expect(plan.towerPositions.map((p) => `${p.x},${p.y}`)).not.toContain(spawnKey);
    expect(plan.labPositions.map((p) => `${p.x},${p.y}`)).not.toContain(spawnKey);
    expect(plan.extensionPositions.map((p) => `${p.x},${p.y}`)).not.toContain(spawnKey);
    expect(`${plan.storagePos.x},${plan.storagePos.y}`).not.toBe(spawnKey);
    expect(`${plan.terminalPos.x},${plan.terminalPos.y}`).not.toBe(spawnKey);
  });

  it('keeps secondary spawns accessible — extensions do not box them in', () => {
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(28, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    expect(plan.spawnPositions.length).toBeGreaterThanOrEqual(2);
    const allOccupied = new Set([
      ...plan.extensionPositions.map((p) => `${p.x},${p.y}`),
      ...plan.towerPositions.map((p) => `${p.x},${p.y}`),
      ...plan.labPositions.map((p) => `${p.x},${p.y}`),
      ...plan.spawnPositions.map((p) => `${p.x},${p.y}`),
      `${plan.storagePos.x},${plan.storagePos.y}`,
      `${plan.terminalPos.x},${plan.terminalPos.y}`,
      ...(plan.factoryPos ? [`${plan.factoryPos.x},${plan.factoryPos.y}`] : []),
    ]);
    const neighbors: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    for (let i = 1; i < plan.spawnPositions.length; i++) {
      const sp = plan.spawnPositions[i]!;
      const open = neighbors.filter(([dx, dy]) => {
        const x = sp.x + dx;
        const y = sp.y + dy;
        return x >= 2 && x <= 47 && y >= 2 && y <= 47 && !allOccupied.has(`${x},${y}`);
      });
      expect(open.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('spawnPositions picks only buildable tiles — no new slot on a live road', () => {
    // Block the first natural candidate range-3 tiles with roads so the planner
    // must skip past them and still fill 3 spawn positions total.
    const spawnX = 25,
      spawnY = 25;
    const roads: any[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        if (Math.abs(dx) !== 3 && Math.abs(dy) !== 3) continue;
        roads.push({
          structureType: STRUCTURE_ROAD,
          pos: new RoomPosition(spawnX + dx, spawnY + dy, 'W1N1'),
        });
      }
    }
    const roadKeys = new Set(roads.map((r) => `${r.pos.x},${r.pos.y}`));
    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(spawnX, spawnY, 'W1N1') }];
      if (type === FIND_STRUCTURES) return opts?.filter ? roads.filter(opts.filter) : roads;
      return [];
    };
    const plan = computeLayout(room)!;
    expect(plan.spawnPositions.length).toBe(3);
    for (const p of plan.spawnPositions) {
      expect(roadKeys.has(`${p.x},${p.y}`)).toBe(false);
    }
  });
});

describe('isAccessible filter in lab stamp loop', () => {
  it('all planned lab positions have ≥1 walkable cardinal neighbour in the final plan', () => {
    // In a clean room, the filter must ensure every placed lab remains reachable.
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(27, 25, 'W1N1') },
    });
    const plan = computeLayout(room)!;
    // Build the set of lab keys to check accessibility in the final configuration.
    const labKeys = new Set(plan.labPositions.map((p) => `${p.x},${p.y}`));
    const spawnKey = '25,25';
    const storageKey = '27,25';
    const towerKeys = new Set(plan.towerPositions.map((p) => `${p.x},${p.y}`));
    const cardinals: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const { x, y } of plan.labPositions) {
      const hasWalkable = cardinals.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 2 || nx > 47 || ny < 2 || ny > 47) return false;
        const key = `${nx},${ny}`;
        if (labKeys.has(key)) return false;
        if (key === spawnKey || key === storageKey) return false;
        if (towerKeys.has(key)) return false;
        return true;
      });
      expect(hasWalkable).toBe(true);
    }
  });

  it('W43N58 regression: stamp positions [5] and [9] rejected, core cluster placed', () => {
    // W43N58: spawn=(16,31), storage=(16,29) → labAx=18, labAy=31
    // LAB_STAMP[5]=[1,2]→(19,33): would strand lab[1]=(19,32) with 0 walkable neighbours
    // LAB_STAMP[9]=[-1,1]→(17,32): would strand lab[2]=(18,32) with 0 walkable neighbours
    const room = makeRoom();
    room.find = (type: number) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(16, 31, 'W1N1') }];
      if (type === FIND_STRUCTURES) return [];
      return [];
    };
    room.getTerrain = () => makeTerrain();
    // Force storage position to (16,29) so labAx=18, labAy=31
    (room as any).storage = { my: true, pos: new RoomPosition(16, 29, 'W1N1') };
    const plan = computeLayout(room)!;
    const labKeys = new Set(plan.labPositions.map((p) => `${p.x},${p.y}`));
    // Rejected positions must not be in the plan
    expect(labKeys.has('19,33')).toBe(false); // stamp[5] — strands (19,32)
    expect(labKeys.has('17,32')).toBe(false); // stamp[9] — strands (18,32)
    // Core cluster must still be placed
    expect(labKeys.has('18,31')).toBe(true); // stamp[0]
    expect(labKeys.has('19,32')).toBe(true); // stamp[1]
    expect(labKeys.has('18,32')).toBe(true); // stamp[2]
  });

  it('under-fill log is emitted when accessibility rejects stamp positions', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(27, 25, 'W1N1') },
    });
    computeLayout(room);
    const calls = consoleSpy.mock.calls.map((args) => args.join(' '));
    const logged = calls.some(
      (msg) => msg.includes('[layout]') && msg.includes('lab stamp can only place'),
    );
    expect(logged).toBe(true);
    consoleSpy.mockRestore();
  });

  it('no log when all buildable stamp positions pass accessibility', () => {
    // Block all lab stamp positions with walls except one — that one passes
    // accessibility trivially (no adjacent non-walkable reserved neighbours).
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // With storage at (27,25): labAx=29, labAy=27
    // Block all stamp positions except [0]=(29,27) with walls
    const walls = new Set<string>();
    const labAx = 29;
    const labAy = 27;
    const LAB_STAMP_LOCAL: [number, number][] = [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
      [2, 1],
      [1, 2],
      [2, 0],
      [0, 2],
      [2, 2],
      [-1, 1],
    ];
    for (const [dx, dy] of LAB_STAMP_LOCAL.slice(1)) {
      walls.add(`${labAx + dx},${labAy + dy}`);
    }
    const room = makeRoom({
      terrain: makeTerrain(walls),
      storage: { my: true, pos: new RoomPosition(27, 25, 'W1N1') },
    });
    computeLayout(room);
    const calls = consoleSpy.mock.calls.map((args) => args.join(' '));
    const logged = calls.some(
      (msg) => msg.includes('[layout]') && msg.includes('lab stamp can only place'),
    );
    expect(logged).toBe(false);
    consoleSpy.mockRestore();
  });
});

describe('isAccessible filter in factory placement', () => {
  it('skips a factory candidate that would strand an adjacent extension', () => {
    // Simulate the W43N58 bug: spawn=(16,31), storage=(16,29).
    // The first candidate adjacent to storage at (17,29) has the extension at (17,28)
    // as its only non-wall cardinal neighbour — placing the factory there would leave
    // the extension with zero walkable cardinals.
    // We reproduce this by placing an extension directly above the first candidate
    // and walling off all other cardinals of that extension.
    //
    // Setup: spawn at (25,25), storage at (27,25).
    // Candidate factory at (28,25) — first ring-1 tile east of storage.
    // Place an extension at (28,24) (directly above candidate).
    // Wall off (28,23) so the extension's only open cardinal would be (28,25) itself
    // (which is blocked if factory is placed there) — making it inaccessible.
    const room = makeRoom({
      storage: { my: true, pos: new RoomPosition(27, 25, 'W1N1') },
    });
    // Wall at (28,23) — extension at (28,24) would then rely on (28,25) as its
    // sole non-wall walkable cardinal, but that's the factory candidate tile.
    const wallSet = new Set<string>(['28,23', '29,24', '27,24']);
    const baseTerrain = makeTerrain();
    room.getTerrain = () => ({
      get: (x: number, y: number) => {
        if (wallSet.has(`${x},${y}`)) return TERRAIN_MASK_WALL;
        return baseTerrain.get(x, y);
      },
    });
    // Inject an extension structure at (28,24) so the liveMap knows it's non-walkable
    room.find = (type: number) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: new RoomPosition(25, 25, 'W1N1') }];
      if (type === FIND_STRUCTURES)
        return [{ structureType: STRUCTURE_EXTENSION, pos: new RoomPosition(28, 24, 'W1N1') }];
      if (type === FIND_MY_CONSTRUCTION_SITES) return [];
      return [];
    };

    const plan = computeLayout(room)!;
    // Factory must NOT be placed at (28,25) — it would strand the extension at (28,24)
    expect(plan.factoryPos).not.toEqual({ x: 28, y: 25 });
  });
});

describe('scoreSpawnCandidate', () => {
  it('returns -1 for out-of-bounds positions', () => {
    const terrain = makeTerrain();
    expect(scoreSpawnCandidate(1, 1, terrain)).toBe(-1);
    expect(scoreSpawnCandidate(48, 48, terrain)).toBe(-1);
  });

  it('returns -1 when the spawn tile is a wall', () => {
    const terrain = makeTerrain(new Set(['25,25']));
    expect(scoreSpawnCandidate(25, 25, terrain)).toBe(-1);
  });

  it('returns a positive score for a fully open area', () => {
    const terrain = makeTerrain();
    const score = scoreSpawnCandidate(25, 25, terrain);
    expect(score).toBeGreaterThan(0);
  });

  it('scores an open area higher than one with few extension slots', () => {
    const openScore = scoreSpawnCandidate(25, 25, makeTerrain());

    // Block most of the stamp area leaving fewer than 50 extension slots
    const walls = new Set<string>();
    for (const [dx, dy] of EXTENSION_STAMP) {
      walls.add(`${25 + dx},${25 + dy}`);
    }
    const constricted = scoreSpawnCandidate(25, 25, makeTerrain(walls));

    expect(openScore).toBeGreaterThan(constricted);
  });

  it('returns -1 when all storage candidates are walls', () => {
    // Block everything in range 2-4 around spawn (10,10)
    const walls = new Set<string>();
    for (let r = 2; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          walls.add(`${10 + dx},${10 + dy}`);
        }
      }
    }
    const terrain = makeTerrain(walls);
    expect(scoreSpawnCandidate(10, 10, terrain)).toBe(-1);
  });
});

describe('pruneUnreachableExtensions', () => {
  // Helper: build a minimal RoomTerrain-like object from a wall key Set.
  function makePruneTerrain(walls: Set<string> = new Set()): any {
    return {
      get: (x: number, y: number) => (walls.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0),
    };
  }

  it('drops a stranded extension whose only walkable neighbour is a sealed pocket', () => {
    // Reproduces the W44N57 pattern: extension E at (30,9); its only walkable
    // 8-neighbour is the pocket tile P at (29,9).  P itself is sealed — every
    // one of its 8 neighbours is either E (an obstacle) or another obstacle key
    // injected below — so the flood never reaches P, and therefore E has no
    // reachable approach tile and gets pruned.
    //
    // E (30,9) 8-neighbours: 29,8  30,8  31,8  29,9(=P)  31,9  29,10  30,10  31,10
    // P (29,9) 8-neighbours: 28,8  29,8  30,8  28,9  30,9(=E)  28,10  29,10  30,10
    //
    // We put the union of both neighbour sets (minus P and E themselves) into the
    // obstacle set, making P completely surrounded and E reachable only via P.
    const spawnPos = { x: 25, y: 25 };
    const terrain = makePruneTerrain(); // no terrain walls

    const obstacles = new Set<string>([
      '25,25', // spawn
      // neighbours of E (30,9) except P (29,9):
      '29,8',
      '30,8',
      '31,8',
      '31,9',
      '29,10',
      '30,10',
      '31,10',
      // additional neighbours of P (29,9) not already listed:
      '28,8',
      '28,9',
      '28,10',
    ]);

    // E is the stranded extension; R is near-spawn and always reachable.
    const strandedExt = { x: 30, y: 9 };
    const reachableExt = { x: 24, y: 23 };
    obstacles.add('30,9'); // E itself is an obstacle (it is an extension)
    obstacles.add('24,23'); // R is also an extension obstacle
    const extensions = [strandedExt, reachableExt];

    const result = pruneUnreachableExtensions(extensions, obstacles, terrain, spawnPos);

    const keys = result.map((p) => `${p.x},${p.y}`);
    expect(keys).not.toContain('30,9'); // stranded via sealed pocket — pruned
    expect(keys).toContain('24,23'); // reachable — kept
  });

  it('fixpoint: stranded extension is dropped and remaining set is self-consistent', () => {
    // Extension A at (40,40) is directly stranded: ALL of its 8 neighbours are in
    // the obstacle set, so it has zero walkable approach tiles and is pruned on the
    // first flood pass.  Extension B at (24,23) is near-spawn and always reachable.
    //
    // A (40,40) 8-neighbours: 39,39  40,39  41,39  39,40  41,40  39,41  40,41  41,41
    // We put all of them in obstacles so A has no walkable approach.
    const spawnPos = { x: 25, y: 25 };
    const terrain = makePruneTerrain();

    const obstacles = new Set<string>([
      '25,25', // spawn
      '39,39',
      '40,39',
      '41,39',
      '39,40',
      '41,40',
      '39,41',
      '40,41',
      '41,41',
    ]);

    const extA = { x: 40, y: 40 }; // stranded
    const extB = { x: 24, y: 23 }; // reachable (near spawn, open corridor)

    obstacles.add('40,40'); // A itself is an extension obstacle
    obstacles.add('24,23'); // B itself is an extension obstacle

    const result = pruneUnreachableExtensions([extA, extB], obstacles, terrain, spawnPos);
    const keys = result.map((p) => `${p.x},${p.y}`);

    // A is stranded (no walkable 8-neighbour) — pruned
    expect(keys).not.toContain('40,40');
    // B is reachable — kept
    expect(keys).toContain('24,23');

    // Self-consistency: every returned extension has at least one non-obstacle 8-neighbour
    // in the post-prune obstacle set (obstacles was mutated — 40,40 removed from it).
    const eight: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    for (const { x, y } of result) {
      const hasOpenNeighbour = eight.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 2 && nx <= 47 && ny >= 2 && ny <= 47 && !obstacles.has(`${nx},${ny}`);
      });
      expect(hasOpenNeighbour).toBe(true);
    }
  });

  it('fail-open: returns list unchanged when spawn has no walkable neighbours', () => {
    // Seal all 8 spawn neighbours — no seeds → fail open, return list as-is.
    const spawnPos = { x: 25, y: 25 };
    const terrain = makePruneTerrain(); // no terrain walls

    const obstacles = new Set<string>([
      '25,25', // spawn
      '24,24',
      '25,24',
      '26,24',
      '24,25',
      '26,25',
      '24,26',
      '25,26',
      '26,26',
    ]);

    const extensions = [
      { x: 24, y: 23 },
      { x: 26, y: 23 },
      { x: 30, y: 30 },
    ];
    for (const p of extensions) obstacles.add(`${p.x},${p.y}`);

    const result = pruneUnreachableExtensions(extensions, obstacles, terrain, spawnPos);

    // Fail-open: all three returned unchanged
    expect(result).toHaveLength(3);
    expect(result.map((p) => `${p.x},${p.y}`)).toEqual(extensions.map((p) => `${p.x},${p.y}`));
  });

  it('no regression: open-terrain room drops no extensions', () => {
    // In open terrain with only the spawn as an obstacle (no other hub structures, no
    // extension obstacles), the entire room is reachable from spawn's neighbours.
    // Every stamp extension has at least one open 8-neighbour that the flood reaches,
    // so pruneUnreachableExtensions must return the list unchanged.
    //
    // NOTE: we intentionally do NOT add extensions to the obstacle set here.
    // pruneUnreachableExtensions checks whether an extension's 8-neighbours contain
    // a REACHABLE tile — if the extensions themselves are not obstacles, the flood
    // covers the whole room and every extension is trivially reachable.  This mirrors
    // the behaviour when roads/open-corridor tiles provide approach paths in a real room.
    const spawnPos = { x: 25, y: 25 };
    const terrain = makePruneTerrain();

    // Only spawn is an obstacle — extensions are NOT added to the obstacle set.
    const obstacles = new Set<string>(['25,25']);
    const extensions: { x: number; y: number }[] = [];
    for (const [dx, dy] of EXTENSION_STAMP) {
      const x = spawnPos.x + dx;
      const y = spawnPos.y + dy;
      if (x >= 2 && x <= 47 && y >= 2 && y <= 47) extensions.push({ x, y });
    }

    const result = pruneUnreachableExtensions(extensions, obstacles, terrain, spawnPos);

    // With a fully open room, no extensions should be pruned.
    expect(result).toHaveLength(extensions.length);
  });

  it('drops a planned extension that would seal a built extension (W42N59 scenario)', () => {
    // W42N59 layout: walls seal the north, built extensions form an inner block,
    // and (20,19) is a walkable pocket tile. Planned extensions at (21,19) and
    // (21,20) seal the corridor — the only path from (20,19) to the reachable
    // room. The pruner BFS through the pocket must find and drop them.
    const spawnPos = { x: 17, y: 23 };
    const walls = new Set<string>(['18,18', '19,18', '20,18', '21,18']);
    const terrain = makeTerrain(walls);

    // Built extensions: the inner block (20,19 is NOT an extension — it's the pocket)
    const builtExtensions = [
      { x: 18, y: 19 },
      { x: 19, y: 19 },
      { x: 18, y: 20 },
      { x: 19, y: 20 },
      { x: 20, y: 20 },
      { x: 18, y: 21 },
      { x: 19, y: 21 },
      { x: 20, y: 21 },
      { x: 21, y: 21 },
    ];

    // Planned extensions that seal the corridor
    const planned = [
      { x: 21, y: 19 },
      { x: 21, y: 20 },
    ];

    // Obstacle set: spawn + all built + planned
    const obstacles = new Set<string>();
    obstacles.add(`${spawnPos.x},${spawnPos.y}`);
    for (const p of builtExtensions) obstacles.add(`${p.x},${p.y}`);
    for (const p of planned) obstacles.add(`${p.x},${p.y}`);

    const result = pruneUnreachableExtensions(
      planned,
      obstacles,
      terrain,
      spawnPos,
      builtExtensions,
    );

    // Both planned extensions should be dropped — they seal built extensions
    expect(result).toHaveLength(0);
  });
});

describe('flood-fill prune integration (via computeLayout)', () => {
  it('pruned stranded extension does not appear in the returned plan', () => {
    // Reproduce the W44N57 scenario: a stamp position whose only walkable approach
    // tile is sealed into a 1-tile pocket by surrounding planned obstacles.
    //
    // We use a targeted wall configuration to guarantee that at least one specific
    // stamp tile is stranded, and verify it is absent from the plan while the overall
    // extension count still satisfies the RCL cap.
    //
    // Spawn at (25,25). Extension stamp has [-1,-2] = (24,23).
    // We want to seal (24,23) by walling off all its 8 neighbours except (25,25) which
    // is the spawn (an obstacle itself), and (23,23) which we also wall.
    // 24,23's 8 neighbours: 23,22  24,22  25,22  23,23  25,23  23,24  24,24  25,24
    // Wall all of them → (24,23)'s only non-wall neighbour would be the spawn tile (25,25)
    // which is an obstacle → (24,23) becomes unreachable.
    const walls = new Set<string>([
      '23,22',
      '24,22',
      '25,22',
      '23,23',
      '25,23',
      '23,24',
      '24,24',
      '25,24',
    ]);
    const room = makeRoom({ terrain: makeTerrain(walls) });
    const plan = computeLayout(room)!;
    const extKeys = new Set(plan.extensionPositions.map((p) => `${p.x},${p.y}`));

    // The sealed extension must be absent from the plan.
    expect(extKeys.has('24,23')).toBe(false);

    // The plan must still have enough extensions for a viable colony.
    expect(plan.extensionPositions.length).toBeGreaterThanOrEqual(30);
  });
});

describe('findStrandedExtensions', () => {
  it('reports a built extension whose all 8 neighbours are obstacles', () => {
    // Build a room fixture: spawn at (25,25); one built extension at (30,9) whose
    // every 8-neighbour is a built non-walkable structure (so the flood can never
    // reach any of them and the extension is reported as stranded).
    //
    // Neighbours of 30,9: 29,8  30,8  31,8  29,9  31,9  29,10  30,10  31,10
    // We surface them all as built extensions (NON_WALKABLE_STRUCTURES) so each
    // one is in the obstacle set and the flood can never reach any of them.
    const spawnPos = new RoomPosition(25, 25, 'W1N1');
    const strandedPos = new RoomPosition(30, 9, 'W1N1');
    const neighbourOffsets: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    const neighbourStructures = neighbourOffsets.map(([dx, dy]) => ({
      structureType: STRUCTURE_EXTENSION,
      pos: new RoomPosition(strandedPos.x + dx, strandedPos.y + dy, 'W1N1'),
    }));
    const strandedStructure = { structureType: STRUCTURE_EXTENSION, pos: strandedPos };
    // A reachable extension near spawn — should NOT appear in results.
    const reachableStructure = {
      structureType: STRUCTURE_EXTENSION,
      pos: new RoomPosition(24, 23, 'W1N1'),
    };
    const allStructures = [...neighbourStructures, strandedStructure, reachableStructure];

    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: spawnPos }];
      if (type === FIND_STRUCTURES)
        return opts?.filter ? allStructures.filter(opts.filter) : allStructures;
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? allStructures.filter(opts.filter) : allStructures;
      if (type === FIND_MY_CONSTRUCTION_SITES) return [];
      return [];
    };

    const result = findStrandedExtensions(room);
    const keys = result.map((p) => `${p.x},${p.y}`);

    expect(keys).toContain('30,9');
    expect(result.find((p) => p.x === 30 && p.y === 9)?.built).toBe(true);
    expect(keys).not.toContain('24,23'); // reachable — not reported
  });

  it('returns empty array when no spawn exists', () => {
    const room = makeRoom();
    room.find = () => [];
    room.getTerrain = () => makeTerrain();
    expect(findStrandedExtensions(room)).toEqual([]);
  });

  it('reports an extension construction site with no reachable approach', () => {
    // Same sealed-pocket geometry but for a CS rather than a built structure.
    const spawnPos = new RoomPosition(25, 25, 'W1N1');
    const strandedPos = new RoomPosition(30, 9, 'W1N1');
    const neighbourOffsets: [number, number][] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    const neighbourStructures = neighbourOffsets.map(([dx, dy]) => ({
      structureType: STRUCTURE_EXTENSION,
      pos: new RoomPosition(strandedPos.x + dx, strandedPos.y + dy, 'W1N1'),
    }));
    const strandedSite = { structureType: STRUCTURE_EXTENSION, pos: strandedPos, id: 'cs1' };

    const room = makeRoom();
    room.find = (type: number, opts?: any) => {
      if (type === FIND_MY_SPAWNS) return [{ pos: spawnPos }];
      if (type === FIND_STRUCTURES)
        return opts?.filter ? neighbourStructures.filter(opts.filter) : neighbourStructures;
      if (type === FIND_MY_STRUCTURES)
        return opts?.filter ? neighbourStructures.filter(opts.filter) : neighbourStructures;
      if (type === FIND_MY_CONSTRUCTION_SITES) {
        const sites = [strandedSite];
        return opts?.filter ? sites.filter(opts.filter) : sites;
      }
      return [];
    };

    const result = findStrandedExtensions(room);
    const keys = result.map((p) => `${p.x},${p.y}`);
    expect(keys).toContain('30,9');
    expect(result.find((p) => p.x === 30 && p.y === 9)?.built).toBe(false);
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
