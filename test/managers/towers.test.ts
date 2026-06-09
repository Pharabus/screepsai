import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { runTowers } from '../../src/managers/towers';
import { pickPriorityTarget } from '../../src/utils/threat';
import { logCombat } from '../../src/utils/combatLog';

vi.mock('../../src/utils/threat', () => ({
  pickPriorityTarget: vi.fn(() => undefined),
}));
vi.mock('../../src/utils/combatLog', () => ({
  logCombat: vi.fn(),
}));

const mockPick = pickPriorityTarget as unknown as ReturnType<typeof vi.fn>;
const mockLog = logCombat as unknown as ReturnType<typeof vi.fn>;

let idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}_${idCounter++}`;
}

function makeTower(opts: { energy?: number; capacity?: number; operational?: boolean } = {}): any {
  const capacity = opts.capacity ?? 1000;
  const energy = opts.energy ?? 1000;
  return {
    id: uid('tower'),
    structureType: STRUCTURE_TOWER,
    hits: 3000,
    hitsMax: 3000,
    pos: {
      x: 25,
      y: 25,
      getRangeTo: (other: any) => {
        const pos = other.pos ?? other;
        return Math.max(Math.abs(25 - pos.x), Math.abs(25 - pos.y));
      },
    },
    store: {
      getUsedCapacity: () => energy,
      getCapacity: () => capacity,
    },
    isActive: () => opts.operational !== false,
    attack: vi.fn(() => 0),
    heal: vi.fn(() => 0),
    repair: vi.fn(() => 0),
  };
}

function makeStruct(structureType: string, opts: { hits: number; x?: number; y?: number }): any {
  return {
    id: uid(structureType),
    structureType,
    hits: opts.hits,
    hitsMax: 100_000_000,
    pos: { x: opts.x ?? 40, y: opts.y ?? 40 },
    isActive: () => true,
  };
}

/**
 * Build a room + register it on Game.rooms. `towers` feeds
 * find(FIND_STRUCTURES) (getStructuresByType, used for tower scan and repair
 * search); `allStructures` overrides the full structure list when you need
 * non-tower structures too; `myCreeps` feeds find(FIND_MY_CREEPS) (wounded
 * heal scan).
 */
function makeRoom(opts: {
  name?: string;
  level?: number;
  storageEnergy?: number;
  towers: any[];
  allStructures?: any[];
  myCreeps?: any[];
}): any {
  const name = opts.name ?? 'W1N1';
  const allStructures = opts.allStructures ?? opts.towers;
  const myCreeps = opts.myCreeps ?? [];
  const storage =
    opts.storageEnergy === undefined
      ? undefined
      : { store: { getUsedCapacity: (_r?: string) => opts.storageEnergy } };
  const room = mockRoom({
    name,
    controller: { my: true, level: opts.level ?? 4 },
    storage,
    find: (type: number, findOpts?: { filter?: (s: any) => boolean }) => {
      let arr: any[];
      if (type === FIND_STRUCTURES) arr = allStructures;
      else if (type === FIND_MY_CREEPS) arr = myCreeps;
      else arr = [];
      if (findOpts?.filter) arr = arr.filter(findOpts.filter);
      return arr;
    },
  });
  Game.rooms[name] = room;
  Memory.rooms[name] = Memory.rooms[name] ?? {};
  return room;
}

describe('runTowers — focus fire', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    mockPick.mockReset();
    mockPick.mockReturnValue(undefined);
    mockLog.mockReset();
  });

  it('fires every tower at the single priority target and skips heal/repair', () => {
    const t1 = makeTower();
    const t2 = makeTower();
    const target = mockCreep({ name: 'enemy' });
    mockPick.mockReturnValue(target);
    makeRoom({ towers: [t1, t2] });

    runTowers();

    expect(t1.attack).toHaveBeenCalledWith(target);
    expect(t2.attack).toHaveBeenCalledWith(target);
    expect(t1.heal).not.toHaveBeenCalled();
    expect(t1.repair).not.toHaveBeenCalled();
  });

  it('ignores non-operational towers', () => {
    const live = makeTower();
    const dead = makeTower({ operational: false });
    const target = mockCreep({ name: 'enemy' });
    mockPick.mockReturnValue(target);
    makeRoom({ towers: [live, dead] });

    runTowers();

    expect(live.attack).toHaveBeenCalledWith(target);
    expect(dead.attack).not.toHaveBeenCalled();
  });

  it('logs tower_energy_low once when a tower is below 25% during combat, then suppresses repeats', () => {
    const lowTower = makeTower({ energy: 100, capacity: 1000 }); // 10%
    const target = mockCreep({ name: 'enemy' });
    mockPick.mockReturnValue(target);
    const room = makeRoom({ towers: [lowTower] });

    runTowers();

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0]![0]).toMatchObject({
      event: 'tower_energy_low',
      room: room.name,
    });
    expect(Memory.rooms[room.name]!.combatTowerDrainLogged).toBe(true);

    // Second tick with the flag already set → no second log.
    resetTickCache();
    runTowers();
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it('does not log tower_energy_low when towers are healthy', () => {
    const t = makeTower({ energy: 900, capacity: 1000 });
    mockPick.mockReturnValue(mockCreep({ name: 'enemy' }));
    makeRoom({ towers: [t] });

    runTowers();

    expect(mockLog).not.toHaveBeenCalled();
  });
});

describe('runTowers — heal & repair (no combat target)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    mockPick.mockReset();
    mockPick.mockReturnValue(undefined);
    mockLog.mockReset();
  });

  it('heals the nearest wounded creep before repairing', () => {
    const wounded = mockCreep({ name: 'hurt', hits: 50, hitsMax: 100 });
    const tower = makeTower();
    const wall = makeStruct(STRUCTURE_WALL, { hits: 100 });
    makeRoom({ towers: [tower], allStructures: [tower, wall], myCreeps: [wounded] });

    runTowers();

    expect(tower.heal).toHaveBeenCalledWith(wounded);
    expect(tower.repair).not.toHaveBeenCalled();
  });

  it('does not repair when tower energy is below the combat reserve (50%)', () => {
    const tower = makeTower({ energy: 100, capacity: 1000 }); // 10% < 50%
    const wall = makeStruct(STRUCTURE_WALL, { hits: 100 }); // well below any max
    makeRoom({ towers: [tower], allStructures: [tower, wall] });

    runTowers();

    expect(tower.repair).not.toHaveBeenCalled();
  });

  it('repairs a damaged wall when energy is above the reserve', () => {
    const tower = makeTower({ energy: 900, capacity: 1000 });
    const wall = makeStruct(STRUCTURE_WALL, { hits: 100 });
    makeRoom({ towers: [tower], allStructures: [tower, wall] });

    runTowers();

    expect(tower.repair).toHaveBeenCalledWith(wall);
  });

  it('skips a rampart co-located on a wall tile but repairs a standalone wall', () => {
    const tower = makeTower({ energy: 900, capacity: 1000 });
    const wallUnderRampart = makeStruct(STRUCTURE_WALL, { hits: 100_000_000, x: 10, y: 10 }); // full HP
    const rampartOnWall = makeStruct(STRUCTURE_RAMPART, { hits: 100, x: 10, y: 10 }); // damaged but on wall tile
    const standaloneWall = makeStruct(STRUCTURE_WALL, { hits: 100, x: 20, y: 20 }); // damaged
    makeRoom({
      towers: [tower],
      allStructures: [tower, rampartOnWall, wallUnderRampart, standaloneWall],
    });

    runTowers();

    expect(tower.repair).toHaveBeenCalledWith(standaloneWall);
    expect(tower.repair).not.toHaveBeenCalledWith(rampartOnWall);
  });
});

describe('wallRepairMax (via repair-target selection)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    mockPick.mockReset();
    mockPick.mockReturnValue(undefined);
    mockLog.mockReset();
  });

  // RCL4: floor 50k, cap 50k. With no storage the floor governs.
  it('uses the per-RCL floor when storage is low', () => {
    const tower = makeTower({ energy: 900 });
    const belowFloor = makeStruct(STRUCTURE_WALL, { hits: 40_000 }); // < 50k floor
    makeRoom({ level: 4, storageEnergy: 0, towers: [tower], allStructures: [tower, belowFloor] });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(belowFloor);
  });

  it('does not repair a wall already at the RCL floor', () => {
    const tower = makeTower({ energy: 900 });
    const atFloor = makeStruct(STRUCTURE_WALL, { hits: 50_000 }); // == 50k floor, not < max
    makeRoom({ level: 4, storageEnergy: 0, towers: [tower], allStructures: [tower, atFloor] });

    runTowers();
    expect(tower.repair).not.toHaveBeenCalled();
  });

  // RCL6: floor 300k, cap 1M. storage 1M → stored*0.5 = 500k governs (> floor, < cap).
  it('uses the storage-scaled value when it exceeds the floor', () => {
    const tower = makeTower({ energy: 900 });
    const below = makeStruct(STRUCTURE_WALL, { hits: 400_000 }); // < 500k scaled max
    const above = makeStruct(STRUCTURE_WALL, { hits: 600_000 }); // > 500k scaled max
    makeRoom({
      level: 6,
      storageEnergy: 1_000_000,
      towers: [tower],
      allStructures: [tower, above, below], // 'above' first → must be skipped
    });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(below);
    expect(tower.repair).not.toHaveBeenCalledWith(above);
  });

  // RCL4: cap 50k. Huge storage would scale to 500k, but the cap clamps it.
  it('clamps to the RCL cap so a wall above the cap is not repaired', () => {
    const tower = makeTower({ energy: 900 });
    const aboveCap = makeStruct(STRUCTURE_WALL, { hits: 60_000 }); // > 50k cap
    makeRoom({
      level: 4,
      storageEnergy: 1_000_000,
      towers: [tower],
      allStructures: [tower, aboveCap],
    });

    runTowers();
    expect(tower.repair).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wallRepairMax — holisticEconomy flag ON (moderate-middle floors)
// ---------------------------------------------------------------------------

describe('wallRepairMax (holisticEconomy ON) — new moderate-middle floors', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    mockPick.mockReset();
    mockPick.mockReturnValue(undefined);
    mockLog.mockReset();
    (Memory as any).holisticEconomy = true;
  });

  /**
   * Like makeRoom but adds my:true to storage so myStorage() returns it.
   * Required for the holistic path (colonyEnergy uses myStorage/myTerminal).
   */
  function makeRoomHolistic(opts: {
    level: number;
    storageEnergy?: number;
    towers: any[];
    allStructures?: any[];
  }): any {
    const name = 'W1N1';
    const allStructures = opts.allStructures ?? opts.towers;
    const storage =
      opts.storageEnergy === undefined
        ? undefined
        : {
            my: true,
            store: { getUsedCapacity: (_r?: string) => opts.storageEnergy },
          };
    const room = mockRoom({
      name,
      controller: { my: true, level: opts.level },
      storage,
      find: (type: number, findOpts?: { filter?: (s: any) => boolean }) => {
        let arr: any[];
        if (type === FIND_STRUCTURES) arr = allStructures;
        else if (type === FIND_MY_CREEPS) arr = [];
        else arr = [];
        if (findOpts?.filter) arr = arr.filter(findOpts.filter);
        return arr;
      },
    });
    Game.rooms[name] = room;
    Memory.rooms[name] = Memory.rooms[name] ?? {};
    return room;
  }

  // RCL6 lean: hard floor is 150k (down from old 300k).
  it('RCL6 lean (surplus=0) → WALL_HARD_FLOOR[6]=150k; wall below 150k is repaired', () => {
    const tower = makeTower({ energy: 900 });
    // stored=25k (= RCL6 buffer); surplus=0 → target=150k floor
    const belowFloor = makeStruct(STRUCTURE_WALL, { hits: 100_000 }); // < 150k
    makeRoomHolistic({
      level: 6,
      storageEnergy: 25_000,
      towers: [tower],
      allStructures: [tower, belowFloor],
    });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(belowFloor);
  });

  it('RCL6 lean: wall at 150k is NOT repaired (already at floor)', () => {
    const tower = makeTower({ energy: 900 });
    const atFloor = makeStruct(STRUCTURE_WALL, { hits: 150_000 }); // == floor
    makeRoomHolistic({
      level: 6,
      storageEnergy: 25_000,
      towers: [tower],
      allStructures: [tower, atFloor],
    });

    runTowers();
    expect(tower.repair).not.toHaveBeenCalled();
  });

  // RCL7 lean: hard floor is 400k (down from old 1M).
  it('RCL7 lean (stored=50k=buffer, surplus=0) → WALL_HARD_FLOOR[7]=400k; wall at 300k is repaired', () => {
    const tower = makeTower({ energy: 900 });
    const belowFloor = makeStruct(STRUCTURE_WALL, { hits: 300_000 }); // < 400k
    makeRoomHolistic({
      level: 7,
      storageEnergy: 50_000,
      towers: [tower],
      allStructures: [tower, belowFloor],
    });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(belowFloor);
  });

  it('RCL7 lean: wall at 400k is NOT repaired', () => {
    const tower = makeTower({ energy: 900 });
    const atFloor = makeStruct(STRUCTURE_WALL, { hits: 400_000 });
    makeRoomHolistic({
      level: 7,
      storageEnergy: 50_000,
      towers: [tower],
      allStructures: [tower, atFloor],
    });

    runTowers();
    expect(tower.repair).not.toHaveBeenCalled();
  });

  // RCL6 with surplus: target = 150k + floor(surplus * 0.5)
  // stored=325k → colonyEnergy=325k, buffer=25k, surplus=300k → target=150k+150k=300k
  it('RCL6 with surplus: target scales above floor (stored=325k → target=300k)', () => {
    const tower = makeTower({ energy: 900 });
    const belowScaled = makeStruct(STRUCTURE_WALL, { hits: 200_000 }); // < 300k
    const aboveScaled = makeStruct(STRUCTURE_WALL, { hits: 350_000 }); // > 300k
    makeRoomHolistic({
      level: 6,
      storageEnergy: 325_000,
      towers: [tower],
      allStructures: [tower, aboveScaled, belowScaled],
    });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(belowScaled);
    expect(tower.repair).not.toHaveBeenCalledWith(aboveScaled);
  });

  // RCL6 cap: WALL_CAPS[6]=1M — huge surplus still clamps.
  it('RCL6 huge storage → still clamps to WALL_CAPS[6]=1M', () => {
    const tower = makeTower({ energy: 900 });
    const aboveCap = makeStruct(STRUCTURE_WALL, { hits: 1_100_000 }); // > 1M cap
    makeRoomHolistic({
      level: 6,
      storageEnergy: 3_000_000,
      towers: [tower],
      allStructures: [tower, aboveCap],
    });

    runTowers();
    expect(tower.repair).not.toHaveBeenCalled();
  });

  // Flag-off path is unchanged: existing suite above covers it.
  it('flag OFF still uses the old floors (RCL6 lean with flag off → old 300k floor)', () => {
    (Memory as any).holisticEconomy = false;
    resetTickCache();
    const tower = makeTower({ energy: 900 });
    // hits=200k < old WALL_FLOOR[6]=300k → repaired under flag-off
    const wall = makeStruct(STRUCTURE_WALL, { hits: 200_000 });
    makeRoom({
      level: 6,
      storageEnergy: 0,
      towers: [tower],
      allStructures: [tower, wall],
    });

    runTowers();
    expect(tower.repair).toHaveBeenCalledWith(wall);
  });
});
