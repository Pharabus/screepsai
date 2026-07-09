import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetGameGlobals } from '../mocks/screeps';

describe('initMemory', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('initialises Memory.creeps/rooms and records a reset tick', async () => {
    vi.resetModules();
    Game.time = 100;
    const { initMemory } = await import('../../src/utils/memoryInit');

    initMemory();

    expect(Memory.creeps).toEqual({});
    expect(Memory.rooms).toEqual({});
    expect(Memory._resets).toEqual([100]);
  });

  it('does not append again on a second call within the same reset', async () => {
    vi.resetModules();
    Game.time = 100;
    const { initMemory } = await import('../../src/utils/memoryInit');

    initMemory();
    Game.time = 105;
    initMemory();

    // Same module instance (same simulated reset) — the `initialised` guard
    // means only the first call's tick is ever recorded.
    expect(Memory._resets).toEqual([100]);
  });

  it('caps the reset history ring at 20 entries, dropping the oldest', async () => {
    // Each simulated reset is a fresh module instance — vi.resetModules() +
    // a dynamic re-import mirrors what actually happens on a real Screeps
    // global reset (the whole sandbox, including all module-level state
    // like the `initialised` flag, is rebuilt from scratch).
    for (let tick = 1; tick <= 25; tick++) {
      vi.resetModules();
      Game.time = tick;
      const { initMemory } = await import('../../src/utils/memoryInit');
      initMemory();
    }

    expect(Memory._resets).toHaveLength(20);
    expect(Memory._resets).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 6), // ticks 6..25 — 1..5 dropped
    );
  });
});
