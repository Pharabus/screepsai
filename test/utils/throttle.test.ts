import {
  shouldRun,
  THROTTLE_CRITICAL,
  THROTTLE_HIGH,
  THROTTLE_NORMAL,
  THROTTLE_LOW,
} from '../../src/utils/throttle';

// Expose Game.cpu via the global mock used by other tests.
// Game is already declared in the screeps mock setup; we just need to set bucket.
function setCpu(bucket: number, time: number = 0): void {
  (global as any).Game = {
    ...(global as any).Game,
    cpu: { bucket, limit: 20, getUsed: () => 0 },
    time,
  };
}

beforeEach(() => {
  setCpu(10000, 0);
});

describe('shouldRun — interval gate', () => {
  it('always fires when interval is 1', () => {
    setCpu(10000, 7);
    expect(shouldRun({ interval: 1, priority: THROTTLE_LOW })).toBe(true);
  });

  it('fires on the correct phase tick', () => {
    setCpu(10000, 5);
    expect(shouldRun({ interval: 5, phase: 0, priority: THROTTLE_LOW })).toBe(true);
  });

  it('does not fire on off-phase ticks', () => {
    setCpu(10000, 3);
    expect(shouldRun({ interval: 5, phase: 0, priority: THROTTLE_LOW })).toBe(false);
  });

  it('respects non-zero phase', () => {
    setCpu(10000, 3);
    expect(shouldRun({ interval: 5, phase: 3, priority: THROTTLE_LOW })).toBe(true);
  });
});

describe('shouldRun — bucket gate', () => {
  it('CRITICAL always runs regardless of bucket', () => {
    setCpu(0);
    expect(shouldRun({ priority: THROTTLE_CRITICAL })).toBe(true);
  });

  it('HIGH skipped below 2000', () => {
    setCpu(1999);
    expect(shouldRun({ priority: THROTTLE_HIGH })).toBe(false);
  });

  it('HIGH runs at exactly 2000', () => {
    setCpu(2000);
    expect(shouldRun({ priority: THROTTLE_HIGH })).toBe(true);
  });

  it('NORMAL skipped below 5000', () => {
    setCpu(4999);
    expect(shouldRun({ priority: THROTTLE_NORMAL })).toBe(false);
  });

  it('NORMAL runs at exactly 5000', () => {
    setCpu(5000);
    expect(shouldRun({ priority: THROTTLE_NORMAL })).toBe(true);
  });

  it('LOW skipped below 8000', () => {
    setCpu(7999);
    expect(shouldRun({ priority: THROTTLE_LOW })).toBe(false);
  });

  it('LOW runs at exactly 8000', () => {
    setCpu(8000);
    expect(shouldRun({ priority: THROTTLE_LOW })).toBe(true);
  });

  it('NORMAL still skipped at 3000 even though HIGH would run', () => {
    setCpu(3000);
    expect(shouldRun({ priority: THROTTLE_HIGH })).toBe(true);
    expect(shouldRun({ priority: THROTTLE_NORMAL })).toBe(false);
  });
});

describe('shouldRun — combined gate', () => {
  it('returns false when interval misses even if bucket is full', () => {
    setCpu(10000, 3);
    expect(shouldRun({ interval: 5, phase: 0, priority: THROTTLE_CRITICAL })).toBe(false);
  });

  it('returns false when bucket low even if interval matches', () => {
    setCpu(1000, 5);
    expect(shouldRun({ interval: 5, phase: 0, priority: THROTTLE_LOW })).toBe(false);
  });

  it('returns true when both interval and bucket pass', () => {
    setCpu(9000, 10);
    expect(shouldRun({ interval: 5, phase: 0, priority: THROTTLE_LOW })).toBe(true);
  });
});
