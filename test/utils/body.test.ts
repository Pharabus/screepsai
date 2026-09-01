import {
  buildBody,
  buildDepositMinerBody,
  buildHunterBody,
  buildKeeperKillerBody,
  buildMinerBody,
  buildRemoteMinerBody,
  buildUpgraderBody,
} from '../../src/utils/body';

describe('buildBody', () => {
  it('returns correct body for exact energy match', () => {
    // [WORK, CARRY, MOVE] costs 100+50+50 = 200
    expect(buildBody([WORK, CARRY, MOVE], 200)).toEqual([WORK, CARRY, MOVE]);
  });

  it('scales repeats with higher energy', () => {
    // 200 per repeat, 550 energy = 2 repeats (400 energy used)
    expect(buildBody([WORK, CARRY, MOVE], 550)).toEqual([WORK, CARRY, MOVE, WORK, CARRY, MOVE]);
  });

  it('does not exceed energy available', () => {
    // 200 per repeat, 399 energy = 1 repeat
    expect(buildBody([WORK, CARRY, MOVE], 399)).toEqual([WORK, CARRY, MOVE]);
  });

  it('respects maxRepeats cap', () => {
    // 200 per repeat, 1000 energy, maxRepeats 2 = 2 repeats (not 5)
    expect(buildBody([WORK, CARRY, MOVE], 1000, 2)).toEqual([WORK, CARRY, MOVE, WORK, CARRY, MOVE]);
  });

  it('returns empty array when energy is insufficient', () => {
    // 200 per repeat, 150 energy = 0 repeats
    expect(buildBody([WORK, CARRY, MOVE], 150)).toEqual([]);
  });

  it('returns empty array for zero-cost pattern', () => {
    expect(buildBody([], 500)).toEqual([]);
  });

  it('default maxRepeats clamps to 50 total parts', () => {
    // [MOVE] costs 50, 10000 energy, default maxRepeats = 50/1 = 50
    const body = buildBody([MOVE], 10000);
    expect(body.length).toBe(50);
  });

  it('handles single WORK body at low energy', () => {
    // [WORK] costs 100, 100 energy = 1 repeat
    expect(buildBody([WORK], 100)).toEqual([WORK]);
  });

  it('handles mixed combat body', () => {
    // [ATTACK, MOVE] costs 80+50 = 130
    expect(buildBody([ATTACK, MOVE], 260)).toEqual([ATTACK, MOVE, ATTACK, MOVE]);
  });

  it('never exceeds MAX_CREEP_SIZE (50) for a pattern length that does not divide 50 evenly', () => {
    // Regression for a live incident (2026-09-01): default maxRepeats was
    // `50 / pattern.length` (16.667 for a 3-part pattern) instead of floored.
    // Math.min(floorRepeats, 16.667) returns the fractional 16.667 once
    // floorRepeats >= 17, and `for (i = 0; i < 16.667; i++)` still runs 17 full
    // iterations — a 51-part body that spawnCreep rejects with ERR_INVALID_ARGS
    // every tick, forever. [WORK, CARRY, MOVE] costs 200/repeat; 5600 energy
    // (RCL7 capacity) affords 28 repeats, well past the old bug's threshold.
    const body = buildBody([WORK, CARRY, MOVE], 5600);
    expect(body.length).toBeLessThanOrEqual(50);
    expect(body.length).toBe(48); // floor(50/3) = 16 repeats * 3 parts
  });

  it('never exceeds MAX_CREEP_SIZE for a 4-part pattern either', () => {
    // 50/4 = 12.5 is also fractional — same class of bug at a different length.
    const body = buildBody([WORK, WORK, CARRY, MOVE], 10000);
    expect(body.length).toBeLessThanOrEqual(50);
    expect(body.length).toBe(48); // floor(50/4) = 12 repeats * 4 parts
  });
});

describe('buildMinerBody', () => {
  it('returns empty when energy too low for 1 WORK + CARRY + MOVE', () => {
    expect(buildMinerBody(199)).toEqual([]);
  });

  it('returns 1W 1C 1M at minimum energy (200)', () => {
    expect(buildMinerBody(200)).toEqual([WORK, CARRY, MOVE]);
  });

  it('returns 2W 1C 1M at 300 energy', () => {
    expect(buildMinerBody(300)).toEqual([WORK, WORK, CARRY, MOVE]);
  });

  it('returns 4W 1C 1M at 550 energy', () => {
    expect(buildMinerBody(550)).toEqual([WORK, WORK, WORK, WORK, CARRY, MOVE]);
  });

  it('returns 5W 1C 1M at 600 energy', () => {
    expect(buildMinerBody(600)).toEqual([WORK, WORK, WORK, WORK, WORK, CARRY, MOVE]);
  });

  it('caps at 6 WORK even with excess energy', () => {
    expect(buildMinerBody(1000)).toEqual([WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE]);
  });
});

describe('buildUpgraderBody', () => {
  it('returns empty when energy too low', () => {
    expect(buildUpgraderBody(199)).toEqual([]);
  });

  it('returns 1W 1C 1M at minimum energy (200)', () => {
    expect(buildUpgraderBody(200)).toEqual([WORK, CARRY, MOVE]);
  });

  it('returns 4W 1C 1M at 550 energy', () => {
    expect(buildUpgraderBody(550)).toEqual([WORK, WORK, WORK, WORK, CARRY, MOVE]);
  });

  it('returns 7W 1C 1M at 800 energy', () => {
    expect(buildUpgraderBody(800)).toEqual([WORK, WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE]);
  });

  it('caps at 15 WORK even with excess energy', () => {
    const body = buildUpgraderBody(5000);
    expect(body.filter((p) => p === WORK).length).toBe(15);
    expect(body).toContain(CARRY);
    expect(body).toContain(MOVE);
  });
});

describe('buildRemoteMinerBody', () => {
  it('returns empty array when energy is insufficient', () => {
    expect(buildRemoteMinerBody(200)).toEqual([]);
  });

  it('caps at 5 WORK by default', () => {
    const body = buildRemoteMinerBody(2300);
    expect(body.filter((p) => p === WORK).length).toBe(5);
    expect(body.filter((p) => p === CARRY).length).toBe(1);
  });

  it('respects maxWork override for reserved rooms', () => {
    const body = buildRemoteMinerBody(2300, 10);
    expect(body.filter((p) => p === WORK).length).toBe(10);
    expect(body.filter((p) => p === CARRY).length).toBe(1);
    // 10 WORK + 1 CARRY + 11 MOVE = 22 parts, cost = 1000+50+550 = 1600 ≤ 2300
    expect(body.filter((p) => p === MOVE).length).toBe(11);
  });

  it('does not exceed energy at maxWork 10', () => {
    // At 1500 energy: (1500-100)/150 = 9.33 → 9 WORK
    const body = buildRemoteMinerBody(1500, 10);
    expect(body.filter((p) => p === WORK).length).toBe(9);
  });
});

describe('buildDepositMinerBody', () => {
  it('returns empty array when energy is insufficient for one unit', () => {
    // 1 unit = WORK(100) + CARRY*2(100) + MOVE*3(150) = 350
    expect(buildDepositMinerBody(300)).toEqual([]);
  });

  it('builds one unit at exactly the unit cost', () => {
    const body = buildDepositMinerBody(350);
    expect(body.filter((p) => p === WORK).length).toBe(1);
    expect(body.filter((p) => p === CARRY).length).toBe(2);
    expect(body.filter((p) => p === MOVE).length).toBe(3);
  });

  it('maintains a 1:1 MOVE-to-non-MOVE ratio at every unit count', () => {
    for (const units of [1, 2, 3, 4]) {
      const body = buildDepositMinerBody(units * 350);
      const moveCount = body.filter((p) => p === MOVE).length;
      const nonMoveCount = body.length - moveCount;
      expect(moveCount).toBe(nonMoveCount);
    }
  });

  it('caps at 4 units by default regardless of available energy', () => {
    const body = buildDepositMinerBody(10000);
    expect(body.filter((p) => p === WORK).length).toBe(4);
    expect(body.filter((p) => p === CARRY).length).toBe(8);
    expect(body.filter((p) => p === MOVE).length).toBe(12);
    expect(body.length).toBe(24);
  });

  it('respects a maxUnits override', () => {
    const body = buildDepositMinerBody(10000, 2);
    expect(body.filter((p) => p === WORK).length).toBe(2);
    expect(body.length).toBe(2 + 4 + 6);
  });

  it('scales down smoothly between unit boundaries (floors, does not round up)', () => {
    // 600 energy: floor(600/350) = 1 unit, not 2
    const body = buildDepositMinerBody(600);
    expect(body.filter((p) => p === WORK).length).toBe(1);
  });
});

describe('buildHunterBody', () => {
  it('returns empty when energy too low', () => {
    expect(buildHunterBody(700)).toEqual([]);
    expect(buildHunterBody(859)).toEqual([]);
  });

  it('returns tier-1 body at 860 energy', () => {
    const body = buildHunterBody(860);
    expect(body.filter((p) => p === TOUGH).length).toBe(2);
    expect(body.filter((p) => p === RANGED_ATTACK).length).toBe(1);
    expect(body.filter((p) => p === ATTACK).length).toBe(3);
    expect(body.filter((p) => p === HEAL).length).toBe(1);
    expect(body.filter((p) => p === MOVE).length).toBe(4);
  });

  it('returns tier-1 body between 860 and 1449', () => {
    const body = buildHunterBody(1000);
    expect(body.filter((p) => p === RANGED_ATTACK).length).toBe(1);
    expect(body.filter((p) => p === ATTACK).length).toBe(3);
    expect(body.filter((p) => p === HEAL).length).toBe(1);
  });

  it('returns tier-2 body at 1450+ energy', () => {
    const body = buildHunterBody(1450);
    expect(body.filter((p) => p === TOUGH).length).toBe(3);
    expect(body.filter((p) => p === RANGED_ATTACK).length).toBe(2);
    expect(body.filter((p) => p === ATTACK).length).toBe(4);
    expect(body.filter((p) => p === HEAL).length).toBe(2);
    expect(body.filter((p) => p === MOVE).length).toBe(6);
  });

  it('places TOUGH parts first for damage absorption', () => {
    const body = buildHunterBody(1450);
    expect(body[0]).toBe(TOUGH);
    expect(body[1]).toBe(TOUGH);
    expect(body[2]).toBe(TOUGH);
  });
});

describe('buildKeeperKillerBody', () => {
  it('returns null below 5300 energy', () => {
    expect(buildKeeperKillerBody(5299)).toBeNull();
    expect(buildKeeperKillerBody(0)).toBeNull();
  });

  it('returns tier-1 body at exactly 5300 energy', () => {
    const body = buildKeeperKillerBody(5300);
    expect(body).not.toBeNull();
    expect(body!.filter((p) => p === TOUGH).length).toBe(6);
    expect(body!.filter((p) => p === MOVE).length).toBe(10);
    expect(body!.filter((p) => p === ATTACK).length).toBe(14);
    expect(body!.filter((p) => p === RANGED_ATTACK).length).toBe(6);
    expect(body!.filter((p) => p === HEAL).length).toBe(4);
  });

  it('returns tier-1 body at 6999 energy', () => {
    const body = buildKeeperKillerBody(6999);
    expect(body!.filter((p) => p === TOUGH).length).toBe(6);
    expect(body!.filter((p) => p === ATTACK).length).toBe(14);
    expect(body!.filter((p) => p === RANGED_ATTACK).length).toBe(6);
    expect(body!.filter((p) => p === HEAL).length).toBe(4);
  });

  it('returns tier-2 body at exactly 7000 energy', () => {
    const body = buildKeeperKillerBody(7000);
    expect(body).not.toBeNull();
    expect(body!.filter((p) => p === TOUGH).length).toBe(8);
    expect(body!.filter((p) => p === MOVE).length).toBe(12);
    expect(body!.filter((p) => p === ATTACK).length).toBe(15);
    expect(body!.filter((p) => p === RANGED_ATTACK).length).toBe(7);
    expect(body!.filter((p) => p === HEAL).length).toBe(8);
  });

  it('returns tier-2 body above 7000 energy', () => {
    const body = buildKeeperKillerBody(10000);
    expect(body!.filter((p) => p === TOUGH).length).toBe(8);
    expect(body!.filter((p) => p === ATTACK).length).toBe(15);
    expect(body!.filter((p) => p === RANGED_ATTACK).length).toBe(7);
  });

  it('never exceeds MAX_CREEP_SIZE (50 parts)', () => {
    expect(buildKeeperKillerBody(5300)!.length).toBeLessThanOrEqual(50);
    expect(buildKeeperKillerBody(7000)!.length).toBeLessThanOrEqual(50);
    expect(buildKeeperKillerBody(50000)!.length).toBeLessThanOrEqual(50);
  });

  it('places TOUGH first and HEAL last for damage absorption', () => {
    const body = buildKeeperKillerBody(5300)!;
    expect(body[0]).toBe(TOUGH);
    expect(body[body.length - 1]).toBe(HEAL);
  });

  it('places TOUGH first and HEAL last in tier-2 body', () => {
    const body = buildKeeperKillerBody(7000)!;
    expect(body[0]).toBe(TOUGH);
    expect(body[body.length - 1]).toBe(HEAL);
  });

  it('places RANGED_ATTACK after ATTACK so it degrades later under damage', () => {
    const body = buildKeeperKillerBody(5300)!;
    const lastAttackIdx = body.lastIndexOf(ATTACK);
    const firstRangedIdx = body.indexOf(RANGED_ATTACK);
    expect(firstRangedIdx).toBeGreaterThan(lastAttackIdx);
  });
});
