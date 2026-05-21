import { cached, invalidate, resetTickCache, getStructuresByType } from '../../src/utils/tickCache';

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

  describe('getStructuresByType', () => {
    it('groups structures by structureType', () => {
      const road = { structureType: STRUCTURE_ROAD };
      const container = { structureType: STRUCTURE_CONTAINER };
      const road2 = { structureType: STRUCTURE_ROAD };
      const room = { name: 'W1N1', find: vi.fn(() => [road, container, road2]) } as any;
      const result = getStructuresByType(room);
      expect(result[STRUCTURE_ROAD]).toHaveLength(2);
      expect(result[STRUCTURE_CONTAINER]).toHaveLength(1);
    });

    it('caches the result within the same tick (find called once)', () => {
      const room = { name: 'W2N2', find: vi.fn(() => []) } as any;
      getStructuresByType(room);
      getStructuresByType(room);
      expect(room.find).toHaveBeenCalledTimes(1);
    });

    it('returns empty partial record when room has no structures', () => {
      const room = { name: 'W3N3', find: vi.fn(() => []) } as any;
      const result = getStructuresByType(room);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('recomputes after resetTickCache', () => {
      const room = { name: 'W4N4', find: vi.fn(() => []) } as any;
      getStructuresByType(room);
      resetTickCache();
      getStructuresByType(room);
      expect(room.find).toHaveBeenCalledTimes(2);
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
