import { isOperational, clearOperational } from '../../src/utils/structures';
import { resetGameGlobals } from '../mocks/screeps';

function mockStructure(active: boolean): Structure & { isActive: ReturnType<typeof vi.fn> } {
  return {
    id: `struct-${Math.random()}` as Id<Structure>,
    isActive: vi.fn(() => active),
  } as any;
}

describe('isOperational', () => {
  beforeEach(() => {
    resetGameGlobals();
    (Game as any).time = 1;
  });

  it('returns true for an active structure', () => {
    const s = mockStructure(true);
    expect(isOperational(s)).toBe(true);
  });

  it('returns false for an inactive structure', () => {
    const s = mockStructure(false);
    expect(isOperational(s)).toBe(false);
  });

  it('calls isActive() only once within TTL (cache hit)', () => {
    const s = mockStructure(true);
    isOperational(s);
    isOperational(s);
    expect(s.isActive).toHaveBeenCalledTimes(1);
  });

  it('returns the same value on cache hit', () => {
    const s = mockStructure(false);
    const first = isOperational(s);
    const second = isOperational(s);
    expect(first).toBe(false);
    expect(second).toBe(false);
  });

  it('recomputes after TTL expiry (500 ticks)', () => {
    const s = mockStructure(true);
    (Game as any).time = 1;
    isOperational(s);
    (Game as any).time = 502; // > 500 ticks later
    isOperational(s);
    expect(s.isActive).toHaveBeenCalledTimes(2);
  });

  it('does NOT recompute before TTL expiry', () => {
    const s = mockStructure(true);
    (Game as any).time = 1;
    isOperational(s);
    (Game as any).time = 499; // still within TTL
    isOperational(s);
    expect(s.isActive).toHaveBeenCalledTimes(1);
  });

  it('clearOperational removes the cache entry, forcing a fresh isActive() call', () => {
    const s = mockStructure(true);
    isOperational(s);
    clearOperational(s.id);
    isOperational(s);
    expect(s.isActive).toHaveBeenCalledTimes(2);
  });

  it('clearOperational does not affect other cached structures', () => {
    const a = mockStructure(true);
    const b = mockStructure(false);
    isOperational(a);
    isOperational(b);
    clearOperational(a.id);
    isOperational(b); // should still be cached
    expect(b.isActive).toHaveBeenCalledTimes(1);
  });
});
