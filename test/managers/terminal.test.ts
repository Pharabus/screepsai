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
    (globalThis as any).ORDER_BUY = 'buy';
    (Game as any).market = {
      getAllOrders: vi.fn(() => []),
    };
  });

  it('does nothing when not on the check interval', () => {
    (Game as any).time = 50;
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      terminal: { store: mockTerminalStore({}) },
    });
    (Game as any).rooms = { W1N1: room };

    runTerminal();

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
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
        store: mockTerminalStore({ H: 60000, energy: 10000 }),
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => [
      { id: 'order1', price: 0.5, remainingAmount: 1000 },
      { id: 'order2', price: 0.8, remainingAmount: 500 },
      { id: 'order3', price: 0.9, remainingAmount: 0 },
    ]);

    runTerminal();

    expect(Game.market.getAllOrders).toHaveBeenCalledWith({
      type: 'buy',
      resourceType: 'H',
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('surplus=10000'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('bestBuy=0.800'));

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
      },
    });
    (Game as any).rooms = { W1N1: room };

    (Game as any).market.getAllOrders = vi.fn(() => []);

    runTerminal();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no buy orders'));

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
      },
    });
    (Game as any).rooms = { W1N1: room };

    runTerminal();

    expect(Game.market.getAllOrders).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
