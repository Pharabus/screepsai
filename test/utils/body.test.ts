import { buildBody } from '../../src/utils/body';

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
