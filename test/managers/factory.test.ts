import { runFactory } from '../../src/managers/factory';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

function makeFactory(batteryStock: number, freeCapacity = 50000): any {
  return {
    id: 'factory1' as Id<StructureFactory>,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_BATTERY ? batteryStock : 0,
      getFreeCapacity: (_resource?: ResourceConstant) => freeCapacity,
    },
    produce: vi.fn(() => OK),
  };
}

function makeStorage(energy: number): any {
  return {
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0),
    },
  };
}

function setupRoom(opts: {
  rcl: number;
  storageEnergy: number;
  batteryStock: number;
  factoryId?: string;
}): Room {
  const factory = makeFactory(opts.batteryStock);
  const storage = makeStorage(opts.storageEnergy);

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
