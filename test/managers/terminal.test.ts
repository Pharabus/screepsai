import {
  runTerminal,
  resetColonySendCache,
  resetReceiversThisTick,
} from '../../src/managers/terminal';
import { mockRoom, resetGameGlobals, seedColony } from '../mocks/screeps';
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

  it('does nothing while the terminal is on cooldown, regardless of tick', () => {
    // No interval alignment required any more — cooldown alone gates terminal
    // ops. A deal's cooldown (often >10 ticks for distant buyers) used to
    // straddle past the next aligned tick and silently skip the room for
    // hundreds of ticks; cooldown===0 fires the very next eligible tick.
    (Game as any).time = 55;
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: mockTerminalStore({ Z: 50000 }), cooldown: 3 },
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
    Memory.terminalDebug = true; // surface the gated "why we didn't sell" diagnostic

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
    Memory.terminalDebug = true; // surface the gated "why we didn't sell" diagnostic

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
    Memory.terminalDebug = true; // surface the gated "why we didn't sell" diagnostic

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

  it('does NOT buy lab inputs for a non-hub colony (full-feeder model)', () => {
    (Game as any).time = 500; // BUY_INTERVAL tick
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // W1N1 is a 3-lab colony WITH a terminal; W3N3 is the hub with more labs.
    const colony = mockRoom({
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
    const hub = mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } }); // 6 labs, no terminal
    (Game as any).rooms = { W1N1: colony, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'H', output: 'ZH' },
      },
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }, // most labs → the hub
    };
    (Game as any).market.getAllOrders = vi.fn((opts: any) => {
      if (opts.resourceType === 'H') {
        return [{ id: 'sell1', price: 0.1, remainingAmount: 5000, roomName: 'W2N2' }];
      }
      return [];
    });

    runTerminal();

    // W1N1 is not the hub → it must not buy; W3N3 is the hub but has no terminal.
    expect(Game.market.deal).not.toHaveBeenCalled();
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
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'active' });
    seedColony('W2N2', { homeRoom: 'W1N1', status: 'active' });

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

// ---------------------------------------------------------------------------
// Per-tick receiver-dedupe guard
// ---------------------------------------------------------------------------

describe('runTerminal — per-tick receiver dedupe', () => {
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

  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
    resetColonySendCache();
    resetReceiversThisTick();
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };
  });

  // SKIPPED — documents the intended behaviour of the forward-looking dedupe
  // guard under a future empire-logistics model (a colony reachable from more
  // than one home room). It cannot be exercised through runTerminal today: each
  // colony has exactly one `homeRoom`, so coloniesForHome() surfaces a receiver
  // for only one sender and the suppression branch is unreachable. The setup
  // below parents the colony to a single home, so the second "sender" never even
  // builds a candidate list — the test would pass with the guard removed. Left
  // as a skipped spec to un-skip when multi-home funding lands. See the
  // _receiversThisTick declaration in terminal.ts.
  it.skip('suppresses a second send to the same receiver when two home rooms both try in the same tick', () => {
    (Game as any).time = SEND_TICK;

    // Home A: W1N1 — high surplus, RCL 7
    const terminalA: any = {
      store: makeTerminalStore({ energy: 20_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const homeA: any = {
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 90_000 : 0) },
      },
      terminal: terminalA,
    };

    // Home B: W3N3 — also high surplus, RCL 7
    const terminalB: any = {
      store: makeTerminalStore({ energy: 20_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const homeB: any = {
      name: 'W3N3',
      controller: { my: true, level: 7 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 90_000 : 0) },
      },
      terminal: terminalB,
    };

    // Shared colony: W2N1 — needs energy (low storage, terminal present)
    const colonyTerminal: any = {
      store: makeTerminalStore({ energy: 2_000 }),
      cooldown: 0,
    };
    const colonyRoom: any = {
      name: 'W2N1',
      controller: { my: true, level: 4 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5_000 : 0) },
      },
      terminal: colonyTerminal,
    };

    (Game as any).rooms = {
      W1N1: homeA,
      W3N3: homeB,
      W2N1: colonyRoom,
    };

    // Both home rooms are parented to the same colony for this test.
    // (In a real game colonies have a single homeRoom, but we're stress-testing
    // the dedupe guard here.)
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'active' });

    (Memory as any).rooms = {
      W1N1: {},
      W3N3: {},
      W2N1: {
        sources: [{ id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' }],
      },
    };
    (Game as any).creeps = { m1: { name: 'm1', memory: { role: 'miner' } } };
    (Game as any).map = {
      ...Game.map,
      getRoomLinearDistance: (_a: string, _b: string) => 1,
    };

    // Run terminal — both rooms will enter sendEnergyToColonies; W2N1 is the
    // only eligible receiver. The first sender (whichever room the engine
    // visits first) should claim the receiver; the second must be suppressed.
    runTerminal();

    const totalSends =
      (terminalA.send?.mock?.calls?.length ?? 0) + (terminalB.send?.mock?.calls?.length ?? 0);
    expect(totalSends).toBe(1);
  });

  it('allows a send to the same receiver on the next tick after resetReceiversThisTick', () => {
    (Game as any).time = SEND_TICK;

    const terminal: any = {
      store: makeTerminalStore({ energy: 20_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const homeRoom: any = {
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 90_000 : 0) },
      },
      terminal,
    };
    const colonyTerminal: any = {
      store: makeTerminalStore({ energy: 2_000 }),
      cooldown: 0,
    };
    const colonyRoom: any = {
      name: 'W2N1',
      controller: { my: true, level: 4 },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5_000 : 0) },
      },
      terminal: colonyTerminal,
    };
    (Game as any).rooms = { W1N1: homeRoom, W2N1: colonyRoom };
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'active' });
    (Memory as any).rooms = {
      W1N1: {},
      W2N1: {
        sources: [{ id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' }],
      },
    };
    (Game as any).creeps = { m1: { name: 'm1', memory: { role: 'miner' } } };
    (Game as any).map = {
      ...Game.map,
      getRoomLinearDistance: (_a: string, _b: string) => 1,
    };

    // Tick 1: first send succeeds
    runTerminal();
    expect(terminal.send).toHaveBeenCalledTimes(1);

    // Simulate next tick: runTerminal clears _receiversThisTick at its top.
    // Advance time past the hysteresis window so _lastColonySend doesn't block.
    (Game as any).time = SEND_TICK + 400; // 400 > COLONY_SEND_HYSTERESIS_TICKS (300)
    runTerminal();

    // The second tick's runTerminal cleared the set at entry, so the send is allowed.
    expect(terminal.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Feeder-to-hub mineral consolidation
// ---------------------------------------------------------------------------

describe('runTerminal — sendMineralsToHub (feeder → hub)', () => {
  /**
   * Tick that satisfies MINERAL_SHIP_INTERVAL (10) without coinciding with
   * BUY_INTERVAL (500) or COLONY_SEND_INTERVAL (100).
   */
  const SHIP_TICK = 10;

  /**
   * A terminal store factory with both getUsedCapacity and getFreeCapacity so
   * it works for both source (feeder) and destination (hub) checks.
   */
  function makeFullTerminalStore(resources: Record<string, number>, totalCapacity = 300_000): any {
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
      value: vi.fn((_r?: string) => {
        const used = Object.values(resources).reduce((a, b) => a + b, 0);
        return Math.max(0, totalCapacity - used);
      }),
    });
    return store;
  }

  function makeSetup() {
    // Feeder: W1N1 — no labs (not the hub), has O: 6000 and energy: 50000 in terminal
    const feederTerminal: any = {
      store: makeFullTerminalStore({ O: 6000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });

    // Hub: W3N3 — more labs, terminal with plenty of free capacity
    const hubTerminal: any = {
      store: makeFullTerminalStore({ energy: 20_000 }), // plenty of free capacity
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });

    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {}, // no labs → not the hub
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }, // most labs → the hub
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100), // affordable cost
      deal: vi.fn(() => OK),
    };

    return { feeder, feederTerminal, hub, hubTerminal };
  }

  beforeEach(() => {
    resetGameGlobals();
    resetColonySendCache();
  });

  it('sends the largest mineral stack from feeder to hub', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { feederTerminal } = makeSetup();

    runTerminal();

    // O is the only non-energy mineral (6000 > MIN_MINERAL_SHIP=1000)
    expect(feederTerminal.send).toHaveBeenCalledWith('O', 6000, 'W3N3', 'mineral consolidation');
    consoleSpy.mockRestore();
  });

  it('picks the LARGEST stack when feeder holds multiple minerals', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Feeder holds H: 2000 and O: 6000 — O is largest
    const feederTerminal: any = {
      store: makeFullTerminalStore({ H: 2000, O: 6000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });
    const hubTerminal: any = {
      store: makeFullTerminalStore({ energy: 20_000 }),
      cooldown: 0,
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    // O (6000) is larger than H (2000) — should ship O
    expect(feederTerminal.send).toHaveBeenCalledWith('O', 6000, 'W3N3', 'mineral consolidation');
    expect(feederTerminal.send).not.toHaveBeenCalledWith(
      'H',
      expect.any(Number),
      'W3N3',
      expect.any(String),
    );
    consoleSpy.mockRestore();
  });

  it('does NOT send when this room IS the hub', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // W3N3 is the hub — it must not ship to itself
    const hubTerminal: any = {
      store: makeFullTerminalStore({ O: 6000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W3N3: hub };
    (Memory as any).rooms = {
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    expect(hubTerminal.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does NOT send a stack below MIN_MINERAL_SHIP (500)', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // O: 400 — below MIN_MINERAL_SHIP (500)
    const feederTerminal: any = {
      store: makeFullTerminalStore({ O: 400, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });
    const hubTerminal: any = {
      store: makeFullTerminalStore({ energy: 20_000 }),
      cooldown: 0,
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    expect(feederTerminal.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips when the energy guard fails (terminal energy < cost + ENERGY_TERMINAL_BUFFER)', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // energy: 4000 — calcTransactionCost returns 1000, buffer is 5000 → 4000 < 1000+5000
    const feederTerminal: any = {
      store: makeFullTerminalStore({ O: 6000, energy: 4_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });
    const hubTerminal: any = {
      store: makeFullTerminalStore({ energy: 20_000 }),
      cooldown: 0,
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    // calcTransactionCost returns 1000 → 4000 < 1000 + 5000 (ENERGY_TERMINAL_BUFFER) → skip
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 1_000),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    expect(feederTerminal.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('clamps send amount to hub terminal free capacity', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const feederTerminal: any = {
      store: makeFullTerminalStore({ O: 6000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });

    // Hub terminal has only 3000 free capacity for O
    const hubStoreResources = { energy: 20_000 };
    const hubTerminalStore: any = {
      ...hubStoreResources,
    };
    Object.defineProperty(hubTerminalStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? ((hubStoreResources as any)[r] ?? 0) : 20_000)),
    });
    Object.defineProperty(hubTerminalStore, 'getFreeCapacity', {
      enumerable: false,
      value: vi.fn((_r?: string) => 3_000), // only 3k free
    });
    const hubTerminal: any = { store: hubTerminalStore, cooldown: 0 };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    // 6000 feeder stock, hub only has 3000 free → clamped to 3000
    expect(feederTerminal.send).toHaveBeenCalledWith('O', 3000, 'W3N3', 'mineral consolidation');
    consoleSpy.mockRestore();
  });

  it('skips when hub terminal free capacity is below MIN_MINERAL_SHIP', () => {
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const feederTerminal: any = {
      store: makeFullTerminalStore({ O: 6000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });

    // Hub terminal has only 400 free — below MIN_MINERAL_SHIP (500)
    const hubTerminalStore: any = {};
    Object.defineProperty(hubTerminalStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn(() => 0),
    });
    Object.defineProperty(hubTerminalStore, 'getFreeCapacity', {
      enumerable: false,
      value: vi.fn((_r?: string) => 400),
    });
    const hubTerminal: any = { store: hubTerminalStore, cooldown: 0 };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });
    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    expect(feederTerminal.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('hub room sells surplus; feeder room with a hub does NOT sell', () => {
    // Two rooms: W3N3 (hub, 6 labs) and W1N1 (feeder, no labs).
    // Both have H: 15000 in their terminals. On a MARKET_INTERVAL tick,
    // only the hub should call market.deal; the feeder must not.
    (Game as any).time = SHIP_TICK; // 10 = MARKET_INTERVAL AND MINERAL_SHIP_INTERVAL

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const feederTerminal: any = {
      store: makeFullTerminalStore({ H: 15_000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const feeder = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: feederTerminal,
    });

    const hubTerminal: any = {
      store: makeFullTerminalStore({ H: 15_000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const hub = mockRoom({
      name: 'W3N3',
      controller: { my: true, level: 7 },
      terminal: hubTerminal,
    });

    (Game as any).rooms = { W1N1: feeder, W3N3: hub };
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] },
    };
    (Game as any).market = {
      getAllOrders: vi.fn(() => [
        { id: 'order1', price: 1.0, remainingAmount: 10_000, roomName: 'W9N9' },
      ]),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    // Hub should sell its surplus H
    expect(Game.market.deal).toHaveBeenCalledWith('order1', expect.any(Number), 'W3N3');
    // Feeder should NOT sell — it ships to the hub instead
    expect(Game.market.deal).not.toHaveBeenCalledWith('order1', expect.any(Number), 'W1N1');

    consoleSpy.mockRestore();
  });

  it('feeder WITH no hub present falls back to selling surplus (hub=undefined path)', () => {
    // Single room (no hub exists): hub === undefined → feeder should still sell surplus.
    (Game as any).time = SHIP_TICK;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const terminal: any = {
      store: makeFullTerminalStore({ H: 15_000, energy: 50_000 }),
      cooldown: 0,
      send: vi.fn(() => OK),
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal,
    });

    // No labIds anywhere → getLabHubName() returns undefined
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: {} };
    (Game as any).market = {
      getAllOrders: vi.fn(() => [
        { id: 'order1', price: 1.0, remainingAmount: 10_000, roomName: 'W9N9' },
      ]),
      calcTransactionCost: vi.fn(() => 100),
      deal: vi.fn(() => OK),
    };

    runTerminal();

    // No hub → fallback to selling surplus locally
    expect(Game.market.deal).toHaveBeenCalledWith('order1', expect.any(Number), 'W1N1');
    consoleSpy.mockRestore();
  });
});
