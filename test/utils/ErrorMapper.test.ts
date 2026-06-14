import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorMapper } from '../../src/utils/ErrorMapper';
import { resetGameGlobals } from '../mocks/screeps';

describe('ErrorMapper error ring (Memory._errors)', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('runs the wrapped fn and writes nothing when it does not throw', () => {
    let ran = false;
    ErrorMapper.wrapLoop(() => {
      ran = true;
    })();
    expect(ran).toBe(true);
    expect((globalThis as any).Memory._errors).toBeUndefined();
  });

  it('records a caught error into Memory._errors with the current tick', () => {
    (globalThis as any).Game.time = 12_345;
    ErrorMapper.wrapLoop(() => {
      throw new Error('boom');
    })();
    const ring = (globalThis as any).Memory._errors;
    expect(ring).toHaveLength(1);
    expect(ring[0].t).toBe(12_345);
    expect(ring[0].msg).toContain('boom');
  });

  it('swallows the error (does not rethrow) so the loop survives', () => {
    expect(() =>
      ErrorMapper.wrapLoop(() => {
        throw new Error('x');
      })(),
    ).not.toThrow();
  });

  it('caps the ring at 20 entries (oldest dropped)', () => {
    for (let i = 0; i < 25; i++) {
      (globalThis as any).Game.time = i;
      ErrorMapper.wrapLoop(() => {
        throw new Error(`err${i}`);
      })();
    }
    const ring = (globalThis as any).Memory._errors;
    expect(ring).toHaveLength(20);
    expect(ring[0].t).toBe(5); // entries 0-4 evicted
    expect(ring[19].t).toBe(24);
  });

  it('truncates an oversized message to keep Memory small', () => {
    ErrorMapper.wrapLoop(() => {
      throw new Error('Z'.repeat(5000));
    })();
    const ring = (globalThis as any).Memory._errors;
    expect(ring[0].msg.length).toBeLessThanOrEqual(1000);
  });
});
