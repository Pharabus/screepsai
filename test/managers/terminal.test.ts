import { runTerminal } from '../../src/managers/terminal';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

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

  it('logs surplus minerals with best buy price', () => {
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
    expect(Game.market.deal).toHaveBeenCalledWith('order2', 500, 'W1N1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('sold 500 H'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0.800'));

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
