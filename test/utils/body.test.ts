import {
  buildBody,
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
