/**
 * Tests for src/utils/economy.ts
 *
 * All tests reset the tick cache in beforeEach because energyBudget() is
 * memoised per-room-per-tick — failing to reset causes cross-test contamination.
 */

import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import {
  colonyEnergy,
  economyStage,
  upgradeBuffer,
  upgradePower,
  upgraderWorkParts,
  wallHpTarget,
  energyBudget,
  UPGRADE_BUFFER,
  ENERGY_PER_UPGRADE_WORK,
  MINERAL_RESERVE_MARGIN,
  SATURATED_THRESHOLD,
  WALL_HARD_FLOOR,
  WALL_CAPS,
} from '../../src/utils/economy';

beforeEach(() => {
  resetGameGlobals();
  resetTickCache();
  (Memory as any).rooms = {};
});

// ---------------------------------------------------------------------------
// colonyEnergy
// ---------------------------------------------------------------------------

describe('colonyEnergy', () => {
  it('returns storage energy only when no terminal', () => {
    const room = mockRoom({
      name: 'W1N1',
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 40_000 : 0) },
      },
    });
    expect(colonyEnergy(room)).toBe(40_000);
  });

  it('returns terminal energy only when no storage', () => {
    const room = mockRoom({
      name: 'W1N1',
      terminal: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 15_000 : 0) },
      },
    });
    expect(colonyEnergy(room)).toBe(15_000);
  });

  it('sums storage + terminal when both present', () => {
    const room = mockRoom({
      name: 'W1N1',
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 60_000 : 0) },
      },
      terminal: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 20_000 : 0) },
      },
    });
    expect(colonyEnergy(room)).toBe(80_000);
  });

  it('returns 0 when neither storage nor terminal present', () => {
    const room = mockRoom({ name: 'W1N1' });
    expect(colonyEnergy(room)).toBe(0);
  });

  it('owner-agnostic: foreign storage (my=false) is excluded', () => {
    const room = mockRoom({
      name: 'W1N1',
      // Foreign storage: my is false — myStorage() returns undefined
      storage: {
        my: false,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 500_000 : 0) },
      },
    });
    expect(colonyEnergy(room)).toBe(0);
  });

  it('owner-agnostic: foreign terminal (my=false) is excluded', () => {
    const room = mockRoom({
      name: 'W1N1',
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 10_000 : 0) },
      },
      terminal: {
        my: false,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 50_000 : 0) },
      },
    });
    expect(colonyEnergy(room)).toBe(10_000); // only the own storage counts
  });
});

// ---------------------------------------------------------------------------
// upgradeBuffer
// ---------------------------------------------------------------------------

describe('upgradeBuffer', () => {
  it.each([
    [4, 10_000], // below RCL5 → default 10k
    [5, 10_000],
    [6, 25_000],
    [7, 50_000],
    [8, 100_000],
  ])('RCL %i → buffer %i', (rcl, expected) => {
    const room = mockRoom({ name: 'W1N1', controller: { level: rcl } });
    expect(upgradeBuffer(room)).toBe(expected);
  });

  it('returns 10k default when no controller', () => {
    const room = mockRoom({ name: 'W1N1', controller: undefined });
    expect(upgradeBuffer(room)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// economyStage
// ---------------------------------------------------------------------------

describe('economyStage', () => {
  it('returns bootstrap when no minerEconomy flag', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1', controller: { level: 7 } });
    expect(economyStage(room)).toBe('bootstrap');
  });

  it('returns growth for RCL < 6 with minerEconomy', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({ name: 'W1N1', controller: { level: 5 } });
    expect(economyStage(room)).toBe('growth');
  });

  it('returns mature for RCL 6 with colonyEnergy below SATURATED_THRESHOLD', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: { my: true, store: { getUsedCapacity: () => 100_000 } },
    });
    expect(economyStage(room)).toBe('mature');
  });

  it('returns saturated when colonyEnergy >= SATURATED_THRESHOLD', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: {
        my: true,
        store: {
          getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? SATURATED_THRESHOLD : 0),
        },
      },
    });
    expect(economyStage(room)).toBe('saturated');
  });

  it('returns mature just below SATURATED_THRESHOLD', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: {
        my: true,
        store: {
          getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? SATURATED_THRESHOLD - 1 : 0),
        },
      },
    });
    expect(economyStage(room)).toBe('mature');
  });
});

// ---------------------------------------------------------------------------
// upgradePower
// ---------------------------------------------------------------------------

describe('upgradePower', () => {
  function makeRcl7Room(stored: number, terminalE = 0) {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    return mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage:
        stored > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
            }
          : undefined,
      terminal:
        terminalE > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? terminalE : 0) },
            }
          : undefined,
    });
  }

  it('returns 1 when colonyEnergy is at the buffer (surplus=0)', () => {
    // RCL7 buffer = 50k; stored=50k → surplus=0 → power=1+0=1
    const room = makeRcl7Room(50_000);
    expect(upgradePower(room)).toBe(1);
  });

  it('returns 1 + floor(surplus / ENERGY_PER_UPGRADE_WORK)', () => {
    // stored=60k → surplus=10k → power=1+2=3
    const room = makeRcl7Room(60_000);
    expect(upgradePower(room)).toBe(1 + Math.floor(10_000 / ENERGY_PER_UPGRADE_WORK));
  });

  it('accounts for terminal energy in surplus', () => {
    // stored=40k + terminal=20k = 60k total; buffer=50k → surplus=10k
    const room = makeRcl7Room(40_000, 20_000);
    expect(upgradePower(room)).toBe(1 + Math.floor(10_000 / ENERGY_PER_UPGRADE_WORK));
  });

  it('doubles power in saturated stage', () => {
    // stored=500k → saturated; surplus=450k → base power=1+90=91 → doubled=182
    const room = makeRcl7Room(SATURATED_THRESHOLD);
    const base = 1 + Math.floor((SATURATED_THRESHOLD - 50_000) / ENERGY_PER_UPGRADE_WORK);
    expect(upgradePower(room)).toBe(base * 2);
  });

  it('is monotonically non-decreasing as stored increases', () => {
    let prev = 0;
    for (let stored = 0; stored <= 600_000; stored += 5_000) {
      resetTickCache();
      const room = makeRcl7Room(stored);
      const power = upgradePower(room);
      expect(power).toBeGreaterThanOrEqual(prev);
      prev = power;
    }
  });
});

// ---------------------------------------------------------------------------
// upgraderWorkParts
// ---------------------------------------------------------------------------

describe('upgraderWorkParts', () => {
  it('mature room: stored < 15k → cap=600 → 5 WORK', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: 2300,
      storage: { my: true, store: { getUsedCapacity: () => 10_000 } },
    });
    expect(upgraderWorkParts(room)).toBe(5);
  });

  it('mature room: 15k ≤ stored < 50k → cap=1100 → 10 WORK', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: 2300,
      storage: { my: true, store: { getUsedCapacity: () => 30_000 } },
    });
    expect(upgraderWorkParts(room)).toBe(10);
  });

  it('mature room: stored ≥ 50k → full cap (energyCapacityAvailable=2300 → 15 WORK)', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: 2300,
      storage: { my: true, store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgraderWorkParts(room)).toBe(15);
  });

  it('caps at 15 WORK regardless of energy capacity', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 8 },
      energyCapacityAvailable: 50_000,
      storage: { my: true, store: { getUsedCapacity: () => 500_000 } },
    });
    expect(upgraderWorkParts(room)).toBe(15);
  });

  it('mature room with no storage: stored=0 < 15k → cap=600 → 5 WORK', () => {
    // stored=0 < 15k → cap=600; workParts = floor((600-100)/100) = 5
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: 2300,
    });
    expect(upgraderWorkParts(room)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// wallHpTarget
// ---------------------------------------------------------------------------

describe('wallHpTarget', () => {
  function makeRcl6Room(stored: number, terminalE = 0) {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    return mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage:
        stored > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
            }
          : undefined,
      terminal:
        terminalE > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? terminalE : 0) },
            }
          : undefined,
    });
  }

  it('RCL6 lean room (surplus=0) → WALL_HARD_FLOOR[6] = 150k', () => {
    // buffer=25k; stored=25k → surplus=0 → wallHpTarget = 150k floor
    const room = makeRcl6Room(25_000);
    expect(wallHpTarget(room)).toBe(WALL_HARD_FLOOR[6]);
  });

  it('RCL6 lean with zero energy → WALL_HARD_FLOOR[6]', () => {
    const room = makeRcl6Room(0);
    expect(wallHpTarget(room)).toBe(WALL_HARD_FLOOR[6]);
  });

  it('RCL6 with surplus scales above the floor', () => {
    // stored=125k → colonyEnergy=125k, buffer=25k, surplus=100k
    // target = 150k + floor(100k * 0.5) = 150k + 50k = 200k
    const room = makeRcl6Room(125_000);
    expect(wallHpTarget(room)).toBe(150_000 + 50_000);
  });

  it('RCL6 rich room → scales but clamps to WALL_CAPS[6] = 1M', () => {
    // stored=2.5M → surplus=2.475M → floor + 2.475M*0.5 = 150k + 1.2375M > 1M cap
    const room = makeRcl6Room(2_500_000);
    expect(wallHpTarget(room)).toBe(WALL_CAPS[6]);
  });

  it('RCL7 lean room → WALL_HARD_FLOOR[7] = 400k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 50_000 : 0) },
      },
    });
    // buffer=50k; stored=50k → surplus=0 → floor=400k
    expect(wallHpTarget(room)).toBe(WALL_HARD_FLOOR[7]);
  });

  it('terminal energy counted in surplus for wall scaling', () => {
    // stored=25k (= buffer) + terminal=50k → surplus=50k → 150k + 25k = 175k
    const room = makeRcl6Room(25_000, 50_000);
    expect(wallHpTarget(room)).toBe(150_000 + 25_000);
  });

  it('is monotonically non-decreasing as colonyEnergy increases', () => {
    let prev = 0;
    for (let stored = 0; stored <= 2_000_000; stored += 50_000) {
      resetTickCache();
      const room = makeRcl6Room(stored);
      const target = wallHpTarget(room);
      expect(target).toBeGreaterThanOrEqual(prev);
      prev = target;
    }
  });
});

// ---------------------------------------------------------------------------
// energyBudget (caching + derived fields)
// ---------------------------------------------------------------------------

describe('energyBudget', () => {
  it('returns the same object on two calls within the same tick (cached)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: { my: true, store: { getUsedCapacity: () => 50_000 } },
    });
    const b1 = energyBudget(room);
    const b2 = energyBudget(room);
    expect(b1).toBe(b2); // same reference — cached
  });

  it('calculates surplus as max(0, total - buffer)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 35_000 : 0) },
      },
    });
    // total=35k, buffer=25k (RCL6), surplus=10k
    const b = energyBudget(room);
    expect(b.total).toBe(35_000);
    expect(b.buffer).toBe(25_000);
    expect(b.surplus).toBe(10_000);
  });

  it('surplus is 0 when total < buffer', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: { my: true, store: { getUsedCapacity: () => 10_000 } },
    });
    // total=10k < buffer=25k → surplus=0
    expect(energyBudget(room).surplus).toBe(0);
  });

  // --- allowMineralMining boundary ---

  it('allowMineralMining: false when total <= buffer + MINERAL_RESERVE_MARGIN', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    // RCL6 buffer=25k; 25k+15k=40k; total=40k → must be > 40k to allow
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: { my: true, store: { getUsedCapacity: () => 40_000 } },
    });
    expect(energyBudget(room).allowMineralMining).toBe(false);
  });

  it('allowMineralMining: true when total > buffer + MINERAL_RESERVE_MARGIN', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    // RCL6 buffer=25k; gate=40k; total=40001 → allowed
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      storage: { my: true, store: { getUsedCapacity: () => 40_001 } },
    });
    expect(energyBudget(room).allowMineralMining).toBe(true);
  });

  it('allowMineralMining: false for RCL5 (< 6)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 5 },
      storage: { my: true, store: { getUsedCapacity: () => 200_000 } },
    });
    expect(energyBudget(room).allowMineralMining).toBe(false);
  });

  it('allowMineralMining: false for bootstrap stage (no minerEconomy)', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { my: true, store: { getUsedCapacity: () => 200_000 } },
    });
    expect(energyBudget(room).allowMineralMining).toBe(false);
  });

  it('allowFactory: true when total > 120k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { my: true, store: { getUsedCapacity: () => 125_000 } },
    });
    expect(energyBudget(room).allowFactory).toBe(true);
  });

  it('allowFactory: false when total <= 120k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { my: true, store: { getUsedCapacity: () => 120_000 } },
    });
    expect(energyBudget(room).allowFactory).toBe(false);
  });

  // --- owner-agnostic ---

  it('colonyEnergy is 0 for a room with only a foreign store', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      // Foreign storage: my=false
      storage: {
        my: false,
        store: { getUsedCapacity: () => 300_000 },
      },
    });
    const b = energyBudget(room);
    expect(b.total).toBe(0);
    expect(b.allowMineralMining).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Collision-invariant test
// ---------------------------------------------------------------------------

/**
 * Structural collision check: for every integer colonyEnergy value 0–600k,
 * the allowMineralMining gate and the upgrader-count function under
 * holisticEconomy must NOT share a single energy value where mining first
 * becomes allowed at the same energy as the 2nd/3rd upgrader fires.
 *
 * Under the continuous formula the upgrader count changes at:
 *   n=2: power ≥ 2×workParts → surplus ≥ (2×wParts - 1) × ENERGY_PER_UPGRADE_WORK
 *
 * The mining gate is at: total > buffer + MINERAL_RESERVE_MARGIN
 *
 * Since MINERAL_RESERVE_MARGIN (15k) is not a multiple of ENERGY_PER_UPGRADE_WORK (5k)
 * and the upgrader formula is continuous, they MAY coincidentally share a value.
 * The important invariant is that the mining gate is set deliberately BELOW the
 * upgrader 2nd-tier (so mining opens before the second upgrader drains the room),
 * and that the combination is structurally stable (mining persists even when a 2nd
 * upgrader is running).
 *
 * This test verifies: once allowMineralMining becomes true, it does not flip back
 * to false as colonyEnergy continues to increase (no oscillation).
 */
describe('collision-invariant: allowMineralMining does not oscillate', () => {
  it('allowMineralMining is monotonically true once it first becomes true (RCL6)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    let miningOn = false;
    for (let stored = 0; stored <= 600_000; stored += 1_000) {
      resetTickCache();
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 6 },
        energyCapacityAvailable: 2300,
        storage: {
          my: true,
          store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
        },
      });
      const b = energyBudget(room);
      if (b.allowMineralMining) {
        miningOn = true;
      }
      // Once mining is on, it must never flip back to off as energy increases
      if (miningOn) {
        expect(b.allowMineralMining).toBe(true);
      }
    }
    // Sanity: mining must have turned on at some point in this range
    expect(miningOn).toBe(true);
  });

  it('mining gate (buffer + MINERAL_RESERVE_MARGIN) is structurally != any upgrader step-threshold', () => {
    // Under holisticEconomy the upgrader count is continuous (no discrete steps),
    // so there are NO upgrader step thresholds. This test verifies the old step
    // thresholds (50k, 150k, 400k at RCL7) are all >= the mining gate (65k at RCL7)
    // or < it — meaning the mining gate was always distinct.
    // RCL7: buffer=50k, miningGate=65k; old upgrader steps: 50k(→2), 150k(→3), 400k(→4)
    // The old 50k step == buffer, which is BELOW the mining gate (65k).
    // This means the old 50k→2-upgrader threshold fired BEFORE the mining gate,
    // causing the collision. The new gate (65k) is above the buffer (50k), and the
    // continuous formula has no step at 65k — so no collision.
    const rcl7Buffer = UPGRADE_BUFFER[7]!;
    const rcl7MiningGate = rcl7Buffer + MINERAL_RESERVE_MARGIN;
    // Old step thresholds that existed
    const oldSteps = [50_000, 150_000, 400_000];
    // None of the old steps should equal the mining gate
    for (const step of oldSteps) {
      expect(step).not.toBe(rcl7MiningGate);
    }
    // And the mining gate is strictly above the first old step (which was the collision)
    expect(rcl7MiningGate).toBeGreaterThan(oldSteps[0]!);
  });
});
