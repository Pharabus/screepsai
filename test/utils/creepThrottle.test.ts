/**
 * Tests for src/utils/creepThrottle.ts
 */

import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { shouldThrottleCreep } from '../../src/utils/creepThrottle';

/** Sets up Game.cpu with the given bucket/tickLimit/getUsed values. */
function setCpu(bucket: number, tickLimit = 500, used = 0): void {
  (Game as any).cpu = {
    bucket,
    tickLimit,
    getUsed: () => used,
  };
}

/** Returns a creep positioned in the room interior (default mock pos is 25,25). */
function interiorCreep(role: CreepRoleName, name = 'creep1'): any {
  return mockCreep({
    name,
    memory: { role },
    room: mockRoom(),
  });
}

/** Returns a creep on a border tile (x=1). */
function borderCreep(role: CreepRoleName, name = 'creep1'): any {
  return mockCreep({
    name,
    memory: { role },
    room: mockRoom(),
    pos: new (globalThis as any).RoomPosition(1, 25, 'W1N1'),
  });
}

beforeEach(() => {
  resetGameGlobals();
  setCpu(5500, 500, 0);
});

describe('shouldThrottleCreep — flag off', () => {
  it('returns false even at bucket 0 for a throttleable role', () => {
    Memory.creepThrottle = false;
    setCpu(0, 500, 0);
    const creep = interiorCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });

  it('returns false when the flag is unset entirely', () => {
    delete (Memory as any).creepThrottle;
    setCpu(0, 500, 0);
    const creep = interiorCreep('builder');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });
});

describe('shouldThrottleCreep — NEVER tier roles', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it.each<CreepRoleName>([
    'defender',
    'rangedDefender',
    'healer',
    'hunter',
    'keeperKiller',
    'miner',
    'claimer',
    'colonyBuilder',
  ])('%s is never throttled, even at bucket 0', (role) => {
    setCpu(0, 500, 0);
    const creep = interiorCreep(role);
    expect(shouldThrottleCreep(creep)).toBe(false);
  });
});

describe('shouldThrottleCreep — border safety', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it('a border creep of a throttleable role is never throttled even when starved', () => {
    setCpu(0, 500, 0);
    const creep = borderCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });
});

describe('shouldThrottleCreep — emergency brake', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it('throttles an interior throttleable creep when getUsed > 0.85*tickLimit', () => {
    setCpu(5500, 20, 18); // 18 > 0.85*20 = 17
    const creep = interiorCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(true);
  });

  it('does not engage the brake when getUsed <= 0.85*tickLimit at a healthy bucket', () => {
    setCpu(5500, 500, 100); // 100 <= 0.85*500 = 425
    const creep = interiorCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });
});

describe('shouldThrottleCreep — threshold edges', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it('TIER_LIGHT: bucket >= throttleAt (2500) never throttles', () => {
    setCpu(2500, 500, 0);
    const creep = interiorCreep('hauler');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });

  it('TIER_LIGHT: bucket <= stopAt (500) always throttles', () => {
    setCpu(500, 500, 0);
    const creep = interiorCreep('hauler');
    expect(shouldThrottleCreep(creep)).toBe(true);
  });

  it('TIER_HEAVY: bucket >= throttleAt (4000) never throttles', () => {
    setCpu(4000, 500, 0);
    const creep = interiorCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(false);
  });

  it('TIER_HEAVY: bucket <= stopAt (1500) always throttles', () => {
    setCpu(1500, 500, 0);
    const creep = interiorCreep('upgrader');
    expect(shouldThrottleCreep(creep)).toBe(true);
  });
});

describe('shouldThrottleCreep — in-band determinism and even spread', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it('same (Game.time, creep.name, bucket) yields a stable result', () => {
    setCpu(3000, 500, 0); // mid-band for TIER_HEAVY (1500..4000)
    Game.time = 12345;
    const creep = interiorCreep('upgrader');
    const first = shouldThrottleCreep(creep);
    const second = shouldThrottleCreep(creep);
    expect(second).toBe(first);
  });

  it('sweeping Game.time across SPREAD.length yields a skip-rate ~= 1 - ratio', () => {
    const throttleAt = 4000;
    const stopAt = 1500;
    const bucket = 2750; // ratio = (2750-1500)/(4000-1500) = 0.5
    const ratio = (bucket - stopAt) / (throttleAt - stopAt);
    setCpu(bucket, 500, 0);

    const SPREAD_LENGTH = 256; // 2^8, per generateEvenSequence(8, 2)
    const creep = interiorCreep('upgrader');
    let skipped = 0;
    for (let t = 0; t < SPREAD_LENGTH; t++) {
      Game.time = t;
      if (shouldThrottleCreep(creep)) skipped++;
    }
    const skipRate = skipped / SPREAD_LENGTH;
    const expected = 1 - ratio;
    // Allow generous tolerance — the Van der Corput sequence's normalized
    // values aren't perfectly uniform, but should track the expected rate.
    expect(skipRate).toBeGreaterThan(expected - 0.15);
    expect(skipRate).toBeLessThan(expected + 0.15);
  });
});

describe('shouldThrottleCreep — tier separation', () => {
  beforeEach(() => {
    Memory.creepThrottle = true;
  });

  it('at bucket 3000, a HEAVY role can throttle while a LIGHT role never does', () => {
    setCpu(3000, 500, 0);

    const heavy = interiorCreep('upgrader', 'heavy1');
    const light = interiorCreep('hauler', 'light1');

    const SPREAD_LENGTH = 256;
    let heavyThrottledAtLeastOnce = false;
    let lightThrottledAtLeastOnce = false;
    for (let t = 0; t < SPREAD_LENGTH; t++) {
      Game.time = t;
      if (shouldThrottleCreep(heavy)) heavyThrottledAtLeastOnce = true;
      if (shouldThrottleCreep(light)) lightThrottledAtLeastOnce = true;
    }

    // HEAVY: bucket (3000) is between stopAt (1500) and throttleAt (4000) ->
    // probabilistic, throttles on at least some slots (e.g. slot with SPREAD=1).
    expect(heavyThrottledAtLeastOnce).toBe(true);
    // LIGHT: bucket (3000) >= throttleAt (2500) -> never throttles, ever.
    expect(lightThrottledAtLeastOnce).toBe(false);
  });
});
