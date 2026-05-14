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

  it('fills storage buffer before overflowing to terminal when storage mineral is below floor', () => {
    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, H: 0 }, 1000000), // 0 H in storage
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
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ H: 50 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // 0 H in storage < 5000 floor → deliver to storage first, not terminal
    expect(creep.transfer).toHaveBeenCalledWith(storage, 'H');
    expect(creep.transfer).not.toHaveBeenCalledWith(terminal, 'H');
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

    // toWithdraw = min(needed=3000, carry=300, available=500) = 300
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'H', 300);
  });

  it('skips lab input load when lab needs less than MIN_LAB_LOAD', () => {
    const inputLab1 = mockLab('lab1', {
      store: mockLabStore({ H: 2995 }, { H: 5 }), // only 5 free — below threshold
    });
    const inputLab2 = mockLab('lab2');
    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 100, H: 500 }),
    };
    const room = mockRoom({ name: 'W1N1', storage, find: vi.fn(() => []) });

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
        storageLinkId: undefined,
      },
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'H', expect.anything());
  });

  it('withdraws lab input from terminal when storage has none', () => {
    const inputLab1 = mockLab('lab1', {
      store: mockLabStore({}, { H: 3000 }), // lab needs H
    });
    const inputLab2 = mockLab('lab2');

    const storage = {
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 100 }), // 0 H in storage
    };
    const terminal = {
      id: 'term1' as any,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({ energy: 10000, H: 5000 }, 300000), // H in terminal
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
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

    // No H in storage → fall back to withdrawing from terminal
    // toWithdraw = min(needed=3000, carry=300, available=5000) = 300
    expect(creep.withdraw).toHaveBeenCalledWith(terminal, 'H', 300);
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'H', expect.anything());
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

describe('hauler pickup priority', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('drains storage link before picking up full source containers', () => {
    const fullContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 1500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 400 }, 800),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        const all = [fullContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'sLink') return storageLink;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: { storageLinkId: 'sLink' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
  });

  it('falls back to full source container when storage link is empty', () => {
    const fullContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 1500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 0 }, 800),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        const all = [fullContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'sLink') return storageLink;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: { storageLinkId: 'sLink' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(fullContainer, RESOURCE_ENERGY);
  });

  it('picks up drops before containers below full threshold', () => {
    const lowContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const drop = {
      resourceType: RESOURCE_ENERGY,
      amount: 100,
      pos: new RoomPosition(10, 10, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        if (opts?.filter) {
          const all = [lowContainer];
          return all.filter(opts.filter);
        }
        return [];
      }),
    });
    room.find = vi.fn((type: number, opts?: any) => {
      if (type === FIND_DROPPED_RESOURCES) {
        const all = [drop];
        return opts?.filter ? all.filter(opts.filter) : all;
      }
      if (type === FIND_STRUCTURES) {
        const all = [lowContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }
      return [];
    }) as any;
    (room as any).energyAvailable = 300;

    Game.getObjectById = vi.fn(() => null) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    creep.pos.findClosestByRange = vi.fn(() => drop) as any;

    hauler.run(creep);

    expect(creep.pickup).toHaveBeenCalledWith(drop);
  });

  it('ignores storage link below drain threshold', () => {
    const fullContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 1500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 100 }, 800),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        const all = [fullContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'sLink') return storageLink;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: { storageLinkId: 'sLink' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
    expect(creep.withdraw).toHaveBeenCalledWith(fullContainer, RESOURCE_ENERGY);
  });

  it('picks up dropped minerals', () => {
    const mineralDrop = {
      id: 'drop1' as Id<Resource>,
      resourceType: 'H',
      amount: 100,
      pos: new RoomPosition(10, 10, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    Game.getObjectById = vi.fn(() => null) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    // First call returns null (no energy drops), second returns mineralDrop
    creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
      if (opts?.filter) {
        const drops = [mineralDrop];
        const filtered = drops.filter(opts.filter);
        return filtered[0] ?? null;
      }
      return null;
    }) as any;

    hauler.run(creep);

    expect(creep.pickup).toHaveBeenCalledWith(mineralDrop);
  });

  it('picks mineral container before partially-full source containers', () => {
    const lowSourceContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const mineralContainer = {
      id: 'cMin' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ H: 200 }, 2000),
      pos: new RoomPosition(30, 30, 'W1N1'),
      room: { name: 'W1N1' },
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        const all = [lowSourceContainer, mineralContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'cMin') return mineralContainer;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: { mineralContainerId: 'cMin' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    creep.pos.findClosestByRange = vi.fn(() => null) as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(mineralContainer, 'H');
  });
});

describe('hauler task commitment', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('continues committed pickup instead of re-evaluating priorities', () => {
    const mineralContainer = {
      id: 'cMin' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ H: 200 }, 2000),
      room: { name: 'W1N1' },
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 400 }, 800),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'cMin') return mineralContainer;
      if (id === 'sLink') return storageLink;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = {
      W1N1: { storageLinkId: 'sLink', mineralContainerId: 'cMin' },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'cMin' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Should continue to mineral container, NOT switch to storage link
    expect(creep.withdraw).toHaveBeenCalledWith(mineralContainer, 'H');
    expect(creep.withdraw).not.toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
  });

  it('clears commitment when target is empty', () => {
    const emptyContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({}, 2000),
      room: { name: 'W1N1' },
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 400 }, 800),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'cSrc') return emptyContainer;
      if (id === 'sLink') return storageLink;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: { storageLinkId: 'sLink' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'cSrc' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Target was empty, should fall through to storage link
    expect(creep.withdraw).toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
  });

  it('urgent responder preempts commitment when creep is far from target', () => {
    const spawn = {
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 100 },
    };
    const container = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 500 }, 2000),
      pos: new RoomPosition(40, 40, 'W1N1'),
      room: { name: 'W1N1' },
    };
    const storage = {
      id: 'stor1' as Id<StructureStorage>,
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: mockStore({ energy: 50000 }, 500000),
    };

    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [spawn]),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'cSrc') return container;
      return null;
    }) as any;

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'cSrc' },
      store: mockStore({}),
      pos: new RoomPosition(26, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(creep);

    // Should preempt — creep is range 1 from storage but range ~20 from container
    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('urgent responder does NOT preempt when creep is close to committed target', () => {
    const spawn = {
      structureType: STRUCTURE_SPAWN,
      store: { getFreeCapacity: () => 100 },
    };
    const container = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 500 }, 2000),
      pos: new RoomPosition(27, 25, 'W1N1'),
      room: { name: 'W1N1' },
    };
    const storage = {
      id: 'stor1' as Id<StructureStorage>,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: mockStore({ energy: 50000 }, 500000),
    };

    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => [spawn]),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'cSrc') return container;
      return null;
    }) as any;

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'cSrc' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;
    (Memory as any).rooms = { W1N1: {} };

    hauler.run(creep);

    // Should NOT preempt — creep is range 2 from committed target
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('continues committed pickup for dropped resources', () => {
    const drop = {
      id: 'drop1' as Id<Resource>,
      amount: 75,
      resourceType: RESOURCE_ENERGY,
      pos: new RoomPosition(10, 10, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    Game.getObjectById = vi.fn((id: string) => {
      if (id === 'drop1') return drop;
      return null;
    }) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'drop1' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.pickup).toHaveBeenCalledWith(drop);
  });
});

describe('hauler delivery priority', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('delivers to storage before controller container when storage is below floor', () => {
    const storage = {
      id: 'stor1',
      pos: new RoomPosition(16, 29, 'W1N1'),
      store: mockStore({ energy: 5000 }, 1000000),
    };

    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: { controllerContainerId: 'cCtrl' },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ energy: 800 }),
      pos: new RoomPosition(16, 28, 'W1N1'),
    });

    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });
});
