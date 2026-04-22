import { cached, invalidate, resetTickCache } from '../../src/utils/tickCache';

describe('tickCache', () => {
  beforeEach(() => {
    resetTickCache();
  });

  describe('cached', () => {
    it('returns computed value on first call', () => {
      const result = cached('key1', () => 42);
      expect(result).toBe(42);
    });

    it('returns cached value on second call', () => {
      const compute = vi.fn(() => 42);
      cached('key2', compute);
      cached('key2', compute);
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('caches different keys independently', () => {
      cached('a', () => 1);
      cached('b', () => 2);
      expect(cached('a', () => 99)).toBe(1);
      expect(cached('b', () => 99)).toBe(2);
    });
  });

  describe('resetTickCache', () => {
    it('clears all cached values', () => {
      const compute = vi.fn(() => 42);
      cached('key3', compute);
      resetTickCache();
      cached('key3', compute);
      expect(compute).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidate', () => {
    it('removes a single key', () => {
      const compute = vi.fn(() => 42);
      cached('key4', compute);
      invalidate('key4');
      cached('key4', compute);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('does not affect other keys', () => {
      cached('keep', () => 1);
      cached('remove', () => 2);
      invalidate('remove');
      expect(cached('keep', () => 99)).toBe(1);
    });
  });
});
