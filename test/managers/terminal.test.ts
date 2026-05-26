import { runTerminal, resetColonySendCache } from '../../src/managers/terminal';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetColonyScoreCache } from '../../src/utils/colonyPlanner';

function mockTerminalStore(resources: Record<string, number>): any {
  const store: Record<string, any> = { ...resources };
  Object.defineProperty(store, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r) return resources[r] ?? 0;
      return Object.values(resources).reduce((a, b) => a + b, 0);
    }),
  });
  return store;
}

describe('runTerminal', () => {
  beforeEach(() => {
    resetGameGlobals();
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };
  });

  it('does nothing when not on the check interval', () => {
    (Game as any).time = 55; // not a multiple of MARKET_INTERVAL (10) or BUY_INTERVAL (500)
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: mockTerminalStore({ Z: 50000 }), cooldown: 0 },
    });
    (Game as any).rooms = { W1N1: room };

    runTerminal();

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
  });

  it('runs sell every MARKET_INTERVAL (10) ticks, not just every 100', () => {
    (Game as any).time = 10; // would have been below the old 100-tick gate
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: mockTerminalStore({ Z: 50000 }), cooldown: 0 },
    });
    (Game as any).rooms = { W1N1: room };
    (Game as any).market.getAllOrders = vi.fn(() => []);

    runTerminal();

    expect(Game.market.getAllOrders).toHaveBeenCalled();
  });

  it('skips sell when buy has just dealt at a coincident interval (tick 500)', () => {
    (Game as any).time = 500; // both BUY_INTERVAL and MARKET_INTERVAL boundary

    // Terminal's cooldown changes from 0 → 10 once buyForLabs deals.
    const terminal: any = {
      store: mockTerminalStore({ energy: 200000, Z: 50000 }),
      cooldown: 0,
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal,
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) => (r === RESOURCE_ENERGY ? 50000 : 0)),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    // Sell-side returns one viable buyer; buy-side returns one viable seller.
    // Deal call also flips terminal cooldown so the sell branch sees it busy.
    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.type === ORDER_SELL && opts.resourceType === 'H') {
        return [{ id: 'sell1', price: 0.1, remainingAmount: 3000, roomName: 'W2N2' }];
      }
      if (opts.type === ORDER_BUY && opts.resourceType === 'Z') {
        return [{ id: 'buy1', price: 5, remainingAmount: 3000, roomName: 'W2N2' }];
      }
      return [];
    });
    (Game as any).market.deal = vi.fn(() => {
      terminal.cooldown = 10;
      return OK;
    });

    runTerminal();

    // Exactly one deal — the buy. Sell should be skipped due to cooldown re-check.
    expect(Game.market.deal).toHaveBeenCalledTimes(1);
    expect(Game.market.deal).toHaveBeenCalledWith('sell1', expect.any(Number), 'W1N1');
  });

  it('does nothing when terminal does not exist', () => {
    (Game as any).time = 100;
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
    });
    (Game as any).rooms = { W1N1: room };

    runTerminal();

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
  });

  it('picks the highest-revenue order, not the highest-price one', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 60000, energy: 100000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    // order1 has lower price but larger volume → 1000*0.5=500cr revenue
    // order2 has higher price but smaller volume → 500*0.8=400cr revenue
    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 0.5, remainingAmount: 1000, roomName: 'W2N2' },
      { id: 'order2', price: 0.8, remainingAmount: 500, roomName: 'W3N3' },
      { id: 'order3', price: 0.9, remainingAmount: 0, roomName: 'W4N4' },
    ]);

    runTerminal();

    expect(Game.market.getAllOrders).toHaveBeenCalledWith({
      type: 'buy',
      resourceType: 'H',
    });
    expect(Game.market.deal).toHaveBeenCalledWith('order1', 1000, 'W1N1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sold 1000 H'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0.500'));

    consoleSpy.mockRestore();
  });

  it('skips 1-unit decoy buy orders when a bulk order is also available', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 30000, energy: 100000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    // Decoy filtered at order-selection (remainingAmount=1 < MIN_DEAL_SIZE=100)
    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'decoy', price: 500, remainingAmount: 1, roomName: 'W2N2' },
      { id: 'bulk', price: 50, remainingAmount: 200, roomName: 'W3N3' },
    ]);

    runTerminal();

    expect(Game.market.deal).toHaveBeenCalledWith('bulk', 200, 'W1N1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sold 200 H'));

    consoleSpy.mockRestore();
  });

  it('refuses to deal when only decoy-sized orders exist', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 30000, energy: 100000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'decoy', price: 500, remainingAmount: 1, roomName: 'W2N2' },
    ]);

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no viable buy orders'));

    consoleSpy.mockRestore();
  });

  it('skips a deal when energy fees exceed 50% of gross revenue', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 30000, energy: 100000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    // dealAmount=200, price=0.5 → revenue=100cr. energyCost=200 → fee > 50% limit (50cr).
    (Game as any).market.calcTransactionCost = vi.fn(() => 200);
    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'cheap', price: 0.5, remainingAmount: 200, roomName: 'W2N2' },
    ]);

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('skipping (energy fee'));

    consoleSpy.mockRestore();
  });

  it('logs no buy orders when none exist', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ O: 75000, energy: 5000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => []);

    runTerminal();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no viable buy orders'));

    consoleSpy.mockRestore();
  });

  it('sells when terminal mineral is between MINERAL_TERMINAL_SELL_FLOOR and MINERAL_TERMINAL_CEILING (previously deadlocked)', () => {
    // Live bug: terminal H=18169, storage H=5000 → total ~23k but terminal portion
    // was below the old 20k sell line. New floor at 10k makes 15k H sellable.
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 15000, energy: 20000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    // surplus = 15000 - 10000 = 5000; order has 5000 remaining → deal amount = 5000
    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 1.0, remainingAmount: 5000, roomName: 'W2N2' },
    ]);
    // calcTransactionCost returns 100 (from beforeEach), well within energy buffer check
    // energy guard: 20000 >= 100 (energyCost) + 5000 (ENERGY_TERMINAL_BUFFER) ✓

    runTerminal();

    expect(Game.market.deal).toHaveBeenCalledWith('order1', 5000, 'W1N1');
    consoleSpy.mockRestore();
  });

  it('computes surplus against the new 10k floor (not the old 20k ceiling)', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 15000, energy: 50000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    // With the 10k floor: surplus = 15000 - 10000 = 5000.
    // With the old 20k ceiling it would have been -5000 (skipped entirely).
    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 1.0, remainingAmount: 10000, roomName: 'W2N2' },
    ]);

    runTerminal();

    // Deal amount = min(surplus=5000, remaining=10000) = 5000
    expect(Game.market.deal).toHaveBeenCalledWith('order1', 5000, 'W1N1');
    consoleSpy.mockRestore();
  });

  it('does NOT sell when terminal mineral is at or below the 10k floor', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 8000, energy: 50000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 1.0, remainingAmount: 10000, roomName: 'W2N2' },
    ]);

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    // getAllOrders should not even be called since amount (8000) <= floor (10000)
    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does NOT sell when terminal mineral is exactly at the 10k floor', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ H: 10000, energy: 50000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 1.0, remainingAmount: 10000, roomName: 'W2N2' },
    ]);

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips energy resources', () => {
    (Game as any).time = 100;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: mockTerminalStore({ energy: 100000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };

    runTerminal();

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('runTerminal — lab buying', () => {
  beforeEach(() => {
    resetGameGlobals();
    (Game as any).market = {
      credits: 1_000_000, // plentiful by default; affordability test overrides
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };
  });

  function makeTerminalStore(resources: Record<string, number>): any {
    const s = mockTerminalStore(resources);
    // Ensure getFreeCapacity is present for terminal checks
    s.getFreeCapacity = vi.fn(() => 300000);
    return s;
  }

  it('buys a missing lab input when labs are configured and energy is sufficient', () => {
    (Game as any).time = 500; // BUY_INTERVAL tick

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 200000 }),
        cooldown: 0,
      },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) =>
            r === RESOURCE_ENERGY ? 50000 : r === 'Z' ? 5000 : 0,
          ),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };

    // Labs configured with active Z+H→ZH reaction, but no H available
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.resourceType === 'H') {
        return [{ id: 'sell1', price: 0.1, remainingAmount: 5000, roomName: 'W2N2' }];
      }
      return [];
    });

    runTerminal();

    expect(Game.market.deal).toHaveBeenCalledWith('sell1', expect.any(Number), 'W1N1');
    consoleSpy.mockRestore();
  });

  it('respects the shard-tuned max buy price (shard3 accepts higher prices)', () => {
    (Game as any).time = 500;
    (Game as any).shard = { name: 'shard3' };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: makeTerminalStore({ energy: 200000 }), cooldown: 0 },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) =>
            r === RESOURCE_ENERGY ? 50000 : r === 'Z' ? 5000 : 0,
          ),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };
    // Order priced at 99cr — above the default 0.5 cap, but below shard3's cap
    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.resourceType === 'H') {
        return [{ id: 'sell_expensive', price: 99, remainingAmount: 5000, roomName: 'W2N2' }];
      }
      return [];
    });

    runTerminal();

    expect(Game.market.deal).toHaveBeenCalledWith('sell_expensive', expect.any(Number), 'W1N1');
    consoleSpy.mockRestore();
  });

  it('rejects the same 99cr order on shard0 (default cap)', () => {
    (Game as any).time = 500;
    (Game as any).shard = { name: 'shard0' };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: makeTerminalStore({ energy: 200000 }), cooldown: 0 },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) =>
            r === RESOURCE_ENERGY ? 50000 : r === 'Z' ? 5000 : 0,
          ),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };
    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.resourceType === 'H') {
        return [{ id: 'sell_expensive', price: 99, remainingAmount: 5000, roomName: 'W2N2' }];
      }
      return [];
    });

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not buy when storage energy is below minimum', () => {
    (Game as any).time = 500;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 10000 }),
        cooldown: 0,
      },
      // no storage → storageEnergy=0, below MIN_BUY_ENERGY_BASE (30k)
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not buy when terminal energy is high but storage energy is below minimum', () => {
    (Game as any).time = 500;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 200000 }), // terminal is flush but storage is not
        cooldown: 0,
      },
      storage: {
        store: {
          getUsedCapacity: vi.fn(() => 5000), // below MIN_BUY_ENERGY_BASE (30k)
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('scales buy amount down to what credits can afford', () => {
    (Game as any).time = 500;
    (Game as any).shard = { name: 'shard3' }; // raise MAX_BUY_PRICE so 99cr passes
    (Game as any).market.credits = 1000; // only enough for ~10 units @ 99cr
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: makeTerminalStore({ energy: 200000 }), cooldown: 0 },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) =>
            r === RESOURCE_ENERGY ? 50000 : r === 'Z' ? 5000 : 0,
          ),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };
    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.resourceType === 'H') {
        return [{ id: 'sell1', price: 99, remainingAmount: 3000, roomName: 'W2N2' }];
      }
      return [];
    });

    runTerminal();

    // Should deal for ~10 units (1000cr / 99cr/unit = 10), not the full 3000-unit batch
    expect(Game.market.deal).toHaveBeenCalledWith('sell1', 10, 'W1N1');
    consoleSpy.mockRestore();
  });

  it('skips buying when credits are too low for even one unit', () => {
    (Game as any).time = 500;
    (Game as any).market.credits = 50; // below MIN_BUY check but let's exercise affordability
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: makeTerminalStore({ energy: 200000 }), cooldown: 0 },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) => (r === RESOURCE_ENERGY ? 50000 : 0)),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips buying when we already have enough of the mineral', () => {
    (Game as any).time = 500;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 200000, H: 4000 }), // H >= BUY_BATCH_SIZE (3000)
        cooldown: 0,
      },
      storage: {
        store: {
          getUsedCapacity: vi.fn((r?: string) => (r === 'H' ? 0 : 0)),
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    runTerminal();

    // H is already above BUY_BATCH_SIZE so no buy should be placed
    const buyCalls = (Game.market.deal as any).mock.calls;
    expect(buyCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('does not buy when no labs are configured', () => {
    (Game as any).time = 500;

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 200000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: {} }; // no labIds

    runTerminal();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it('does not run buying logic on non-BUY_INTERVAL ticks', () => {
    (Game as any).time = 100; // sell tick, not buy tick

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: {
        store: makeTerminalStore({ energy: 200000 }),
        cooldown: 0,
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
    };

    runTerminal();

    // Only sell-side orders should be queried (for surplus minerals), not buy orders
    const allOrdersCalls = (Game.market.getAllOrders as any).mock.calls;
    const buyCalls = allOrdersCalls.filter((c: any) => c[0]?.type === ORDER_SELL);
    expect(buyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Score-driven colony energy funnel
// ---------------------------------------------------------------------------

describe('runTerminal — colony energy send', () => {
  /** Tick that satisfies COLONY_SEND_INTERVAL (100). */
  const SEND_TICK = 100;

  function makeTerminalStore(resources: Record<string, number>): any {
    const store: Record<string, any> = { ...resources };
    Object.defineProperty(store, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => {
        if (r) return resources[r] ?? 0;
        return Object.values(resources).reduce((a, b) => a + b, 0);
      }),
    });
    Object.defineProperty(store, 'getFreeCapacity', {
      enumerable: false,
      value: vi.fn((_r?: string) => 300_000),
    });
    return store;
  }

  function makeColonySendSetup() {
    // Home room: W1N1 — RCL 7, 90k storage, terminal with 20k energy
    const homeTerminal: any = {
      store: makeTerminalStore({ energy: 20_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const home = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 90_000 : 0),
        },
      },
      terminal: homeTerminal,
    });

    // Colony A: W2N1 — RCL 4, 10k storage (below 30k target), terminal present
    // High priority: rclFactor=4, 1 active source → score ~12 (modest)
    const colATerminal: any = {
      store: makeTerminalStore({ energy: 5_000 }),
      cooldown: 0,
    };
    const colARoom: any = {
      name: 'W2N1',
      controller: { my: true, level: 4 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 10_000 : 0) },
      },
      terminal: colATerminal,
    };

    // Colony B: W2N2 — RCL 5, 5k storage (more urgent), same sources
    const colBTerminal: any = {
      store: makeTerminalStore({ energy: 3_000 }),
      cooldown: 0,
    };
    const colBRoom: any = {
      name: 'W2N2',
      controller: { my: true, level: 5 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5_000 : 0) },
      },
      terminal: colBTerminal,
    };

    (Game as any).rooms = {
      W1N1: home,
      W2N1: colARoom,
      W2N2: colBRoom,
    };

    // Both colonies parented by W1N1
    (Memory as any).colonies = {
      W2N1: { homeRoom: 'W1N1', status: 'active', selectedAt: 1 },
      W2N2: { homeRoom: 'W1N1', status: 'active', selectedAt: 1 },
    };

    // Source data so scores are non-zero (1 active-miner source each)
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true },
      W2N1: {
        sources: [{ id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' }],
      },
      W2N2: {
        sources: [{ id: 's2', x: 10, y: 10, containerId: 'c2', minerName: 'm2' }],
      },
    };
    (Game as any).creeps = {
      m1: { name: 'm1', memory: { role: 'miner' } },
      m2: { name: 'm2', memory: { role: 'miner' } },
    };

    // Distance: both colonies are equidistant for simplicity
    (Game as any).map = {
      ...Game.map,
      getRoomLinearDistance: (_a: string, _b: string) => 1,
    };

    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    return { home, homeTerminal };
  }

  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
    resetColonySendCache();
  });

  it('sends energy to the highest-priority colony with a terminal below storage threshold', () => {
    (Game as any).time = SEND_TICK;
    const { homeTerminal } = makeColonySendSetup();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runTerminal();

    // W2N2 has RCL 5 (rclFactor=3 vs W2N1 rclFactor=4) AND lower storage (5k vs 10k).
    // BUT W2N1 (RCL 4) has a higher rclFactor (4 > 3), so it should receive first
    // since score is sorted by score descending.
    // W2N1 score ≈ 4 × 10 × (10k/20k) = 20; W2N2 score ≈ 3 × 10 × (5k/20k) = 7.5
    expect(homeTerminal.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      'W2N1',
      'colony energy support',
    );
    consoleSpy.mockRestore();
  });

  it('does not send when home storage is below HOME_SURPLUS_FLOOR (80k)', () => {
    (Game as any).time = SEND_TICK;
    makeColonySendSetup();

    // Override home storage to be below floor
    (Game as any).rooms['W1N1'].storage.store.getUsedCapacity = () => 50_000;
    const homeTerminal = (Game as any).rooms['W1N1'].terminal;

    runTerminal();

    expect(homeTerminal.send).not.toHaveBeenCalled();
  });

  it('does not send when colony storage is already at or above target (30k)', () => {
    (Game as any).time = SEND_TICK;
    const { homeTerminal } = makeColonySendSetup();

    // Both colonies above COLONY_STORAGE_TARGET
    (Game as any).rooms['W2N1'].storage.store.getUsedCapacity = () => 35_000;
    (Game as any).rooms['W2N2'].storage.store.getUsedCapacity = () => 40_000;

    runTerminal();

    expect(homeTerminal.send).not.toHaveBeenCalled();
  });

  it('does not send when colony has no terminal (RCL < 6, pre-terminal stage)', () => {
    (Game as any).time = SEND_TICK;
    const { homeTerminal } = makeColonySendSetup();

    // Remove both colony terminals
    (Game as any).rooms['W2N1'].terminal = undefined;
    (Game as any).rooms['W2N2'].terminal = undefined;

    runTerminal();

    expect(homeTerminal.send).not.toHaveBeenCalled();
  });

  it('respects hysteresis — does not resend on the same route within COLONY_SEND_HYSTERESIS_TICKS', () => {
    (Game as any).time = SEND_TICK;
    const { homeTerminal } = makeColonySendSetup();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // First send at tick 100 — W2N1 is the best candidate and receives the energy
    runTerminal();
    expect(homeTerminal.send).toHaveBeenCalledTimes(1);
    expect(homeTerminal.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      'W2N1',
      expect.any(String),
    );

    // Mark W2N2 as well-stocked so it is not a fallback candidate
    (Game as any).rooms['W2N2'].storage.store.getUsedCapacity = () => 35_000;

    // Advance to tick 200 — multiple of COLONY_SEND_INTERVAL (100) so
    // sendEnergyToColonies IS entered. W2N2 is ineligible (storage ≥ 30k) and
    // W2N1's route has lastSent=100, so 200-100=100 < 300 → _lastColonySend
    // guard blocks the resend.
    (Game as any).time = SEND_TICK + 100;
    runTerminal();

    // Still only 1 total call — the _lastColonySend guard blocked the resend to W2N1
    expect(homeTerminal.send).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('sends again after the hysteresis window expires', () => {
    (Game as any).time = SEND_TICK;
    const { homeTerminal } = makeColonySendSetup();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // First send at tick 100
    runTerminal();
    expect(homeTerminal.send).toHaveBeenCalledTimes(1);

    // Advance to tick 500 — multiple of 100, and 500-100=400 > 300 so hysteresis
    // has expired and the second send should go through.
    (Game as any).time = SEND_TICK + 400;
    runTerminal();

    // Second send went through — cumulative count is now 2
    expect(homeTerminal.send).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});
