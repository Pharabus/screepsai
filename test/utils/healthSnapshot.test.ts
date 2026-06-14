import { describe, it, expect, beforeEach } from 'vitest';
import { writeHealthSnapshot, HEALTH_SNAPSHOT_INTERVAL } from '../../src/utils/healthSnapshot';
import { resetGameGlobals, mockRoom } from '../mocks/screeps';

/** Give the bare mock Game the cpu/market/gcl shape writeHealthSnapshot reads. */
function withMarket(overrides: Record<string, any> = {}): void {
  const g = (globalThis as any).Game;
  g.cpu = { bucket: 9000, limit: 20, tickLimit: 500, getUsed: () => 5, ...overrides.cpu };
  g.gcl = { level: 4, progress: 322, progressTotal: 1000 };
  g.market = {
    credits: 1_234_567,
    orders: {},
    outgoingTransactions: [],
    incomingTransactions: [],
    ...overrides.market,
  };
}

describe('writeHealthSnapshot', () => {
  beforeEach(() => {
    resetGameGlobals();
    withMarket();
  });

  it('writes a snapshot only for owned rooms, with terse storage/terminal/labs', () => {
    const lab = { structureType: 'lab', mineralType: 'GH', store: { GH: 1500 } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7, progress: 50, progressTotal: 200, safeMode: 0 },
      energyAvailable: 5600,
      energyCapacityAvailable: 5600,
      storage: { my: true, store: { energy: 100_000, GH2O: 5000 } },
      terminal: { my: true, store: { energy: 15_000, Z: 400 } },
      find: () => [lab],
    });
    const foreign = mockRoom({ name: 'W2N2', controller: { my: false, level: 5 } });
    (globalThis as any).Game.rooms = { W1N1: room, W2N2: foreign };
    (globalThis as any).Memory.rooms = {
      W1N1: { boostLabId: 'lab1', boostCompound: 'GH2O', activeReaction: { output: 'GH' } },
    };

    writeHealthSnapshot();
    const h = (globalThis as any).Memory._health;

    expect(h.rooms).toHaveLength(1); // foreign room excluded
    const r = h.rooms[0];
    expect(r.n).toBe('W1N1');
    expect(r.rcl).toBe(7);
    expect(r.cp).toBe(25); // 100*50/200
    expect(r.se).toBe('5600/5600');
    expect(r.stE).toBe(100_000);
    expect(r.stM).toEqual({ GH2O: 5000 }); // energy excluded
    expect(r.tE).toBe(15_000);
    expect(r.tM).toEqual({ Z: 400 });
    expect(r.lab).toEqual(['GH:1500']);
    expect(r.bl).toBe('GH2O');
    expect(r.rx).toBe('GH');
  });

  it('reports null stores and empty labels when structures are absent or empty', () => {
    const emptyLab = { structureType: 'lab', mineralType: undefined, store: {} };
    const room = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 4, progress: 0, progressTotal: 1000, safeMode: 0 },
      storage: undefined,
      terminal: undefined,
      find: () => [emptyLab],
    });
    (globalThis as any).Game.rooms = { W3N3: room };

    writeHealthSnapshot();
    const r = (globalThis as any).Memory._health.rooms[0];
    expect(r.stE).toBeNull();
    expect(r.stM).toEqual({});
    expect(r.tE).toBeNull();
    expect(r.lab).toEqual(['-:0']);
    expect(r.bl).toBeNull();
    expect(r.rx).toBeNull();
  });

  it('ignores a previous owner store (myStorage/myTerminal owner-guard)', () => {
    const room = mockRoom({
      name: 'W4N4',
      controller: { my: true, level: 6, progress: 0, progressTotal: 1 },
      storage: { my: false, store: { energy: 607_000 } }, // reclaimed husk
      terminal: undefined,
      find: () => [],
    });
    (globalThis as any).Game.rooms = { W4N4: room };

    writeHealthSnapshot();
    const r = (globalThis as any).Memory._health.rooms[0];
    expect(r.stE).toBeNull(); // foreign storage not counted
    expect(r.stM).toEqual({});
  });

  it('captures sys + filtered market activity (sells/buys/transfers split by order)', () => {
    withMarket({
      market: {
        credits: 1_575_124,
        orders: { o1: {}, o2: {} },
        outgoingTransactions: [
          { amount: 510, resourceType: 'Z', order: { price: 21.14 } },
          { amount: 565, resourceType: 'O', order: { price: 44.7 } },
        ],
        incomingTransactions: [
          { amount: 549, resourceType: 'L', order: { price: 110.83 } },
          { amount: 980, resourceType: 'Z', from: 'W44N57', to: 'W43N58' }, // transfer (no order)
        ],
      },
    });
    (globalThis as any).Game.time = 80_860_027;
    (globalThis as any).Memory.stats = { 'main.loop': { avg: 18.66, last: 0, max: 0, samples: 1 } };
    (globalThis as any).Game.rooms = {};

    writeHealthSnapshot();
    const h = (globalThis as any).Memory._health;

    expect(h.t).toBe(80_860_027);
    expect(h.sys.b).toBe(9000);
    expect(h.sys.cr).toBe(1_575_124);
    expect(h.sys.ord).toBe(2);
    expect(h.sys.loop).toBe(18.66);
    expect(h.sys.sells).toEqual(['510Z@21.14', '565O@44.70']);
    expect(h.sys.buys).toEqual(['549L@110.83']); // transfer excluded from buys
    expect(h.sys.tr).toEqual(['980Z W44N57>W43N58']); // and surfaced as a transfer
    expect(typeof h.boost).toBe('string');
  });

  it('loop is null when profiling stats are absent', () => {
    (globalThis as any).Game.rooms = {};
    writeHealthSnapshot();
    expect((globalThis as any).Memory._health.sys.loop).toBeNull();
  });

  it('snapshot interval is a sane positive cadence', () => {
    expect(HEALTH_SNAPSHOT_INTERVAL).toBeGreaterThan(0);
  });
});
