import { runFactory } from '../../src/managers/factory';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

function makeFactory(
  batteryStock: number,
  freeCapacity = 50000,
  extraStock: Record<string, number> = {},
): any {
  const stock: Record<string, number> = { [RESOURCE_BATTERY]: batteryStock, ...extraStock };
  return {
    id: 'factory1' as Id<StructureFactory>,
    level: undefined,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => (resource ? (stock[resource] ?? 0) : 0),
      getFreeCapacity: (_resource?: ResourceConstant) => freeCapacity,
    },
    produce: vi.fn(() => OK),
  };
}

function makeStorage(energy: number, extraStock: Record<string, number> = {}): any {
  const stock: Record<string, number> = { [RESOURCE_ENERGY]: energy, ...extraStock };
  return {
    my: true,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => (resource ? (stock[resource] ?? 0) : 0),
    },
  };
}

function setupRoom(opts: {
  rcl: number;
  storageEnergy: number;
  batteryStock: number;
  factoryId?: string;
  storageStock?: Record<string, number>;
  factoryStock?: Record<string, number>;
}): Room {
  const factory = makeFactory(opts.batteryStock, 50000, opts.factoryStock);
  const storage = makeStorage(opts.storageEnergy, opts.storageStock);

  (Game as any).rooms = {};
  (Memory as any).rooms = {};

  const room = mockRoom({
    name: 'W1N1',
    controller: {
      my: true,
      level: opts.rcl,
      pos: new (globalThis as any).RoomPosition(30, 30, 'W1N1'),
    },
    storage,
    find: vi.fn(() => []),
  });

  (Game as any).rooms['W1N1'] = room;
  (Memory as any).rooms['W1N1'] = {
    factoryId: opts.factoryId ?? factory.id,
    factoryRecipe: undefined,
  };

  (Game as any).getObjectById = vi.fn((id: string) => {
    if (id === factory.id) return factory;
    return null;
  });

  (room as any)._factory = factory;
  return room;
}

describe('runFactory', () => {
  it('calls factory.produce when storage > 120k and battery stock < 500', () => {
    // FACTORY_ENERGY_FLOOR is 120k (raised from 50k so the factory only consumes
    // genuine surplus above the upgrader-expansion band).
    const room = setupRoom({ rcl: 7, storageEnergy: 130_000, batteryStock: 0 });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_BATTERY);
  });

  it('sets factoryRecipe to RESOURCE_BATTERY when producing', () => {
    setupRoom({ rcl: 7, storageEnergy: 130_000, batteryStock: 0 });
    runFactory();
    expect(Memory.rooms['W1N1']?.factoryRecipe).toBe(RESOURCE_BATTERY);
  });

  it('skips when storage energy is at the floor (≤ 120k)', () => {
    const room = setupRoom({ rcl: 7, storageEnergy: 120_000, batteryStock: 0 });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it('skips when battery stock is at the cap (≥ 500)', () => {
    // Use storage well above the 120k floor so the skip is due to battery cap only.
    const room = setupRoom({ rcl: 7, storageEnergy: 130_000, batteryStock: 500 });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).not.toHaveBeenCalled();
  });

  it('clears factoryRecipe when conditions are not met', () => {
    setupRoom({ rcl: 7, storageEnergy: 40_000, batteryStock: 0 });
    (Memory as any).rooms['W1N1'].factoryRecipe = RESOURCE_BATTERY;
    runFactory();
    expect(Memory.rooms['W1N1']?.factoryRecipe).toBeUndefined();
  });

  it('does not run for rooms below RCL 7', () => {
    const room = setupRoom({ rcl: 6, storageEnergy: 130_000, batteryStock: 0 });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).not.toHaveBeenCalled();
  });
});

describe('runFactory — silicon chain (wire)', () => {
  it('produces utrium_bar when silicon is present but utrium_bar is short and U is available', () => {
    const room = setupRoom({
      rcl: 7,
      storageEnergy: 130_000,
      batteryStock: 0,
      storageStock: { silicon: 500, U: 1000 },
    });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith('utrium_bar');
    expect(Memory.rooms['W1N1']?.factoryRecipe).toBe('utrium_bar');
  });

  it('produces wire once both silicon and utrium_bar are sufficiently stocked', () => {
    const room = setupRoom({
      rcl: 7,
      storageEnergy: 130_000,
      batteryStock: 0,
      storageStock: { silicon: 500, U: 1000 },
      factoryStock: { utrium_bar: 20 },
    });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith('wire');
    expect(Memory.rooms['W1N1']?.factoryRecipe).toBe('wire');
  });

  it('falls back to battery when silicon is present but no U is available (chain blocked)', () => {
    const room = setupRoom({
      rcl: 7,
      storageEnergy: 130_000,
      batteryStock: 0,
      storageStock: { silicon: 500 }, // no U, no utrium_bar
    });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_BATTERY);
    expect(Memory.rooms['W1N1']?.factoryRecipe).toBe(RESOURCE_BATTERY);
  });

  it('ignores the silicon chain entirely when the room has never mined a deposit', () => {
    const room = setupRoom({
      rcl: 7,
      storageEnergy: 130_000,
      batteryStock: 0,
      storageStock: { U: 1000 }, // U present but no silicon — chain never engages
    });
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith(RESOURCE_BATTERY);
  });

  it('counts terminal stock alongside storage when deciding chain viability', () => {
    const room = setupRoom({
      rcl: 7,
      storageEnergy: 130_000,
      batteryStock: 0,
      storageStock: { silicon: 500 },
    });
    (room as any).terminal = {
      my: true,
      store: {
        getUsedCapacity: (r?: ResourceConstant) => (r === 'U' ? 1000 : 0),
      },
    };
    runFactory();
    const factory = (room as any)._factory;
    expect(factory.produce).toHaveBeenCalledWith('utrium_bar');
  });
});
