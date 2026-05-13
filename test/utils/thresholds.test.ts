import { getMaxBuyPrice } from '../../src/utils/thresholds';
import { resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

describe('getMaxBuyPrice', () => {
  it('returns the default 0.5 when Game.shard is undefined (test environment)', () => {
    expect(getMaxBuyPrice()).toBe(0.5);
  });

  it('returns 0.5 for shard0', () => {
    (Game as any).shard = { name: 'shard0' };
    expect(getMaxBuyPrice()).toBe(0.5);
  });

  it('returns the shard3-tuned cap for shard3 (illiquid market)', () => {
    (Game as any).shard = { name: 'shard3' };
    expect(getMaxBuyPrice()).toBeGreaterThan(50);
  });

  it('falls back to the default for unknown shards', () => {
    (Game as any).shard = { name: 'shardZ' };
    expect(getMaxBuyPrice()).toBe(0.5);
  });
});
