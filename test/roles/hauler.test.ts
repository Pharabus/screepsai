import { hauler } from '../../src/roles/hauler';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';

function mockStore(contents: Record<string, number> = {}, capacity = 300): any {
  const store: Record<string, any> = {};
  for (const [key, val] of Object.entries(contents)) {
    if (val > 0) store[key] = val;
  }
  Object.defineProperty(store, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r === undefined) {
        let total = 0;
        for (const v of Object.values(contents)) total += v;
        return total;
      }
      return contents[r] ?? 0;
    }),
  });
  Object.defineProperty(store, 'getFreeCapacity', {
    enumerable: false,
    value: vi.fn((_r?: string) => {
      const total = Object.values(contents).reduce((a, b) => a + b, 0);
      return Math.max(0, capacity - total);
    }),
  });
  Object.defineProperty(store, 'getCapacity', {
    enumerable: false,
    value: vi.fn(() => capacity),
  });
  return store;
}

function mockLabStore(stored: Record<string, number>, free: Record<string, number> = {}): any {
  const store: Record<string, any> = {};
  for (const [key, val] of Object.entries(stored)) {
    if (val > 0) store[key] = val;
  }
  Object.defineProperty(store, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r === undefined) {
        let total = 0;
        for (const v of Object.values(stored)) total += v;
        return total;
      }
      return stored[r] ?? 0;
    }),
  });
  Object.defineProperty(store, 'getFreeCapacity', {
    enumerable: false,
    value: vi.fn((r?: string) => {
      if (r && free[r] !== undefined) return free[r];
      return 3000;
    }),
  });
  Object.defineProperty(store, 'getCapacity', {
    enumerable: false,
    value: vi.fn(() => 3000),
  });
  return store;
}

function mockLab(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    structureType: STRUCTURE_LAB,
    mineralType: overrides.mineralType ?? null,
    cooldown: overrides.cooldown ?? 0,
    store: overrides.store ?? mockLabStore({}, {}),
    pos: new RoomPosition(30, 30, 'W1N1'),
    ...overrides,
  };
}

describe('hauler terminal logistics', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('delivers minerals to terminal when terminal exists', () => {
    const terminal = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({}),
    };
    const room = mockRoom({
      name: 'W1N1',
      terminal,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ H: 50 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(terminal, 'H');
  });

  it('delivers minerals to storage when no terminal exists', () => {
    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({}),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal: undefined,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ H: 50 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(storage, 'H');
  });

  it('picks up excess minerals from storage for terminal transfer when idle', () => {
    const storageStore = mockStore({ energy: 100, H: 8000 }, 1000000);
    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}, 300000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'H');
  });

  it('does not move minerals to terminal when storage is below floor', () => {
    const storageStore = mockStore({ energy: 100, H: 3000 });
    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Should NOT withdraw H from storage — 3000 is below the 5000 floor
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'H');
  });
});

describe('hauler lab logistics', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('withdraws lab input mineral from storage when input lab needs filling', () => {
    const inputLab1 = mockLab('lab1', {
      store: mockLabStore({}, { H: 3000 }),
    });
    const inputLab2 = mockLab('lab2');

    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 100, H: 500 }),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'H');
  });

  it('delivers lab input mineral to the correct input lab', () => {
    const inputLab1 = mockLab('lab1', {
      store: mockLabStore({}, { H: 2000 }),
    });
    const inputLab2 = mockLab('lab2');

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ H: 50 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(inputLab1, 'H');
  });

  it('collects compounds from output labs', () => {
    const outputLab = mockLab('lab3', {
      mineralType: 'OH',
      store: mockLabStore({ OH: 500 }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab3') return outputLab;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(outputLab, 'OH');
  });

  it('does not collect from input labs', () => {
    const inputLab1 = mockLab('lab1', {
      mineralType: 'H',
      store: mockLabStore({ H: 1000 }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2'],
      },
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(inputLab1, 'H');
  });
});

describe('hauler urgent responder', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  function makeSpawn(): any {
    return {
      structureType: STRUCTURE_SPAWN,
      store: {
        getFreeCapacity: () => 100,
      },
    };
  }

  it('nearest hauler to storage pulls from storage when structures need energy', () => {
    const storage = {
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: mockStore({ energy: 50000 }, 500000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [makeSpawn()]),
    });

    const nearHauler = mockCreep({
      name: 'hauler_near',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(26, 25, 'W1N1'),
    });
    const farHauler = mockCreep({
      name: 'hauler_far',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(40, 40, 'W1N1'),
    });

    Game.creeps = { hauler_near: nearHauler, hauler_far: farHauler } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(nearHauler);

    expect(nearHauler.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('non-nearest hauler skips urgent need and does normal pickup', () => {
    const storage = {
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: mockStore({ energy: 50000 }, 500000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [makeSpawn()]),
    });

    const nearHauler = mockCreep({
      name: 'hauler_near',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(26, 25, 'W1N1'),
    });
    const farHauler = mockCreep({
      name: 'hauler_far',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(40, 40, 'W1N1'),
    });

    Game.creeps = { hauler_near: nearHauler, hauler_far: farHauler } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(farHauler);

    // Far hauler should NOT withdraw from storage for urgent needs
    expect(farHauler.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('no hauler responds when structures are full', () => {
    const fullSpawn = {
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 0 },
    };
    const storage = {
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: mockStore({ energy: 50000 }, 500000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [fullSpawn]),
    });

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(26, 25, 'W1N1'),
    });

    Game.creeps = { hauler_1: creep } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(creep);

    // Should not pull from storage — no urgent need
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('no hauler responds when storage has no energy', () => {
    const storage = {
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: mockStore({}, 500000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [makeSpawn()]),
    });

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(26, 25, 'W1N1'),
    });

    Game.creeps = { hauler_1: creep } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });
});
