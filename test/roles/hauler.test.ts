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
      my: true,
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
      my: true,
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
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      my: true,
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

    // Surplus is 8000-5000=3000, capped by the hauler's 300 free capacity.
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'H', 300);
  });

  it('hub room: withdraws only the surplus above the 5k floor, never dropping storage below it (no pull/redeposit loop)', () => {
    // Hub room: lab buffer floor = MINERAL_STORAGE_FLOOR (5000).
    // Storage mineral sits just above the floor (5000+200). A full-capacity
    // withdraw would drop storage below the floor, and the delivery would then
    // route straight back to storage — a futile loop. The hauler must take only
    // the 200-unit surplus.
    const storageStore = mockStore({ energy: 100, GH2O: 5200 }, 1000000);
    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      my: true,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}, 300000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    // W1N1 is the hub (has the most labs) — floor = MINERAL_STORAGE_FLOOR (5000)
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3', 'lab4', 'lab5', 'lab6'] },
    };
    // Must be in Game.rooms so getLabHubName() can find the hub
    (Game as any).rooms = { W1N1: room };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}), // 300 free capacity, well above the 200 surplus
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Only the 200-unit surplus above the 5k floor — not a full 300 load that
    // would breach the floor and trigger a pull/redeposit loop.
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'GH2O', 200);
  });

  it('feeder room: withdraws ALL mineral (floor=0) since no lab buffer is needed', () => {
    // Feeder room: mineralStorageFloor = 0 — all stock flows to terminal for hub shipment.
    // Same setup as the hub test above, but W1N1 is NOT the hub.
    const storageStore = mockStore({ energy: 100, GH2O: 5200 }, 1000000);
    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      my: true,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}, 300000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    // W3N3 is the hub (more labs); W1N1 is a feeder — floor = 0
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['lab1', 'lab2', 'lab3', 'lab4', 'lab5', 'lab6'] },
    };
    (Game as any).rooms = {
      W1N1: room,
      W3N3: mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } }),
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}), // 300 free capacity
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Floor=0 for feeder → withdraw the full carry capacity (min(5200, 300)=300)
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'GH2O', 300);
  });

  it('hub room: fills storage buffer before overflowing to terminal when storage mineral is below floor', () => {
    // Hub room: lab buffer floor = MINERAL_STORAGE_FLOOR (5000).
    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, H: 0 }, 1000000), // 0 H in storage
    };
    const terminal = {
      my: true,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}, 300000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    // W1N1 is the hub — floor = MINERAL_STORAGE_FLOOR (5000)
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3', 'lab4', 'lab5', 'lab6'] },
    };
    // Must be in Game.rooms so getLabHubName() can find the hub
    (Game as any).rooms = { W1N1: room };

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

  it('feeder room: delivers mineral directly to terminal (floor=0, no storage buffer needed)', () => {
    // Feeder room: mineralStorageFloor = 0 — mineral goes straight to terminal.
    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, H: 0 }, 1000000), // 0 H in storage
    };
    const terminal = {
      my: true,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}, 300000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    // W3N3 is the hub; W1N1 is a feeder — floor = 0
    (Memory as any).rooms = {
      W1N1: {},
      W3N3: { labIds: ['lab1', 'lab2', 'lab3', 'lab4', 'lab5', 'lab6'] },
    };
    (Game as any).rooms = {
      W1N1: room,
      W3N3: mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } }),
    };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ H: 50 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Floor=0 → storage already "above" floor → deliver straight to terminal
    expect(creep.transfer).toHaveBeenCalledWith(terminal, 'H');
    expect(creep.transfer).not.toHaveBeenCalledWith(storage, 'H');
  });

  it('hub room: does not move minerals to terminal when storage is below the 5k floor', () => {
    // Hub room: mineralStorageFloor = MINERAL_STORAGE_FLOOR (5000).
    // Storage holds 3000 H — below the 5k lab-buffer floor — so no terminal pickup.
    const storageStore = mockStore({ energy: 100, H: 3000 });
    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: storageStore,
    };
    const terminal = {
      my: true,
      pos: new RoomPosition(28, 28, 'W1N1'),
      store: mockStore({}),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      terminal,
      find: vi.fn(() => []),
    });

    // W1N1 is the hub — floor = MINERAL_STORAGE_FLOOR (5000)
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3', 'lab4', 'lab5', 'lab6'] },
    };
    // Must be in Game.rooms so getLabHubName() can find the hub
    (Game as any).rooms = { W1N1: room };

    const creep = mockCreep({
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    // Should NOT withdraw H from storage — 3000 is below the 5000 hub floor
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'H');
  });
});

describe('hauler lab logistics', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
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

  it('skips lab work when another hauler in the room is already claimed to a lab', () => {
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

    const busyHauler = mockCreep({
      name: 'hauler_busy',
      room,
      memory: { role: 'hauler', state: 'PICKUP', targetId: 'lab3' },
      store: mockStore({}),
      pos: new RoomPosition(40, 40, 'W1N1'),
    });
    const freeHauler = mockCreep({
      name: 'hauler_free',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    Game.creeps = { hauler_busy: busyHauler, hauler_free: freeHauler } as any;

    hauler.run(freeHauler);

    expect(freeHauler.withdraw).not.toHaveBeenCalledWith(outputLab, 'OH');
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

  it('preempts storage link drain when a large dropped pile exists', () => {
    const bigDrop = {
      id: 'drop1' as Id<Resource>,
      resourceType: RESOURCE_ENERGY,
      amount: 3000,
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 799 }, 800),
      pos: new RoomPosition(16, 28, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        if (_type === FIND_DROPPED_RESOURCES) {
          const all = [bigDrop];
          return opts?.filter ? all.filter(opts.filter) : all;
        }
        return [];
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
      pos: new RoomPosition(15, 28, 'W1N1'),
    });
    creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
      const drops = [bigDrop];
      const filtered = opts?.filter ? drops.filter(opts.filter) : drops;
      return filtered[0] ?? null;
    }) as any;

    hauler.run(creep);

    expect(creep.pickup).toHaveBeenCalledWith(bigDrop);
    expect(creep.withdraw).not.toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
  });

  it('does not preempt link drain for a small drop below the large-drop threshold', () => {
    const smallDrop = {
      id: 'drop1' as Id<Resource>,
      resourceType: RESOURCE_ENERGY,
      amount: 200, // below LARGE_DROP_THRESHOLD (1000)
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const storageLink = {
      id: 'sLink' as Id<StructureLink>,
      store: mockStore({ energy: 600 }, 800),
      pos: new RoomPosition(16, 28, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
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
      pos: new RoomPosition(15, 28, 'W1N1'),
    });
    creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
      const drops = [smallDrop];
      const filtered = opts?.filter ? drops.filter(opts.filter) : drops;
      return filtered[0] ?? null;
    }) as any;

    hauler.run(creep);

    // Link drain wins because the drop isn't yet large enough to preempt
    expect(creep.withdraw).toHaveBeenCalledWith(storageLink, RESOURCE_ENERGY);
    expect(creep.pickup).not.toHaveBeenCalledWith(smallDrop);
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

    const storage = {
      id: 'storage1' as Id<StructureStorage>,
      my: true,
      store: mockStore({ energy: 20000 }, 1000000),
      structureType: STRUCTURE_STORAGE,
      pos: new RoomPosition(25, 24, 'W1N1'),
    };
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
      storage,
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

  it('picks up ruins between dropped minerals and full source containers', () => {
    const ruin = {
      id: 'ruin1' as Id<Ruin>,
      pos: new RoomPosition(12, 14, 'W1N1'),
      store: mockStore({ energy: 4000 }, 5000),
    };
    const fullSourceContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 1500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES) {
          const all = [fullSourceContainer];
          return opts?.filter ? all.filter(opts.filter) : all;
        }
        return [];
      }),
    });

    Game.getObjectById = vi.fn(() => null) as any;
    Game.creeps = { hauler_1: {} } as any;
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(13, 14, 'W1N1'),
    });
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_RUINS) {
        const items = [ruin];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      return null;
    }) as any;

    hauler.run(creep);

    // Ruin is collected before the full source container
    expect(creep.withdraw).toHaveBeenCalledWith(ruin, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(fullSourceContainer, RESOURCE_ENERGY);
  });

  it('prefers the closer of a ruin and tombstone', () => {
    const farRuin = {
      id: 'ruin1' as Id<Ruin>,
      pos: new RoomPosition(40, 40, 'W1N1'),
      store: mockStore({ energy: 4000 }, 5000),
    };
    const closeTomb = {
      id: 'tomb1' as Id<Tombstone>,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 100 }, 1000),
    };

    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });

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
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_RUINS) {
        const items = [farRuin];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      if (type === FIND_TOMBSTONES) {
        const items = [closeTomb];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      return null;
    }) as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(closeTomb, RESOURCE_ENERGY);
  });

  it('skips non-energy abandoned loot when room has no storage or terminal', () => {
    const mineralTomb = {
      id: 'tomb1' as Id<Tombstone>,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: {
        getUsedCapacity: (r?: string) => (r === undefined ? 5 : r === RESOURCE_ENERGY ? 0 : 5),
      },
    };

    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });

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
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_TOMBSTONES) {
        const items = [mineralTomb];
        return (opts?.filter ? items.filter(opts.filter) : items)[0] ?? null;
      }
      return null;
    }) as any;

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('skips dropped minerals when room has no storage or terminal', () => {
    const mineralDrop = {
      id: 'drop1' as Id<Resource>,
      resourceType: 'H',
      amount: 100,
      pos: new RoomPosition(10, 10, 'W1N1'),
    };

    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });

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
    creep.pos.findClosestByRange = vi.fn((type: number, opts?: any) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return (opts?.filter ? [mineralDrop].filter(opts.filter) : [mineralDrop])[0] ?? null;
      }
      // Return null for FIND_RUINS / FIND_TOMBSTONES so pickupAbandonedLoot doesn't crash
      return null;
    }) as any;

    hauler.run(creep);

    expect(creep.pickup).not.toHaveBeenCalled();
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
      my: true,
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

  it('drops mineral when stuck in deliver with no storage or terminal', () => {
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: {} };
    Game.creeps = { hauler_1: {} } as any;

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ UH: 5 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });

    hauler.run(creep);

    expect(creep.drop).toHaveBeenCalledWith('UH');
    expect(creep.transfer).not.toHaveBeenCalled();
  });
});

describe('hauler boost lab servicing', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('withdraws boost compound from storage when lab is below mineral target', () => {
    const boostLab = mockLab('boostLab', {
      store: mockLabStore({ UH: 100 }, { UH: 2900, energy: 2000 }), // 100 stored, needs more
    });
    const storage = {
      id: 'stor1' as any,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, UH: 2000 }, 1000000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab') return boostLab;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab',
        boostCompound: 'UH',
      },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // Needs 1500 target - 100 stored = 1400 compound; carry is 300
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'UH', 300);
  });

  it('delivers boost compound to the boost lab when carrying it', () => {
    const boostLab = mockLab('boostLab', {
      store: mockLabStore({ UH: 100 }, { UH: 2900, energy: 2000 }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab') return boostLab;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab',
        boostCompound: 'UH',
      },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ UH: 200 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(boostLab, 'UH');
  });

  it('withdraws energy from storage when boost lab energy is below target', () => {
    const boostLab = mockLab('boostLab', {
      store: mockLabStore(
        { UH: 1500, energy: 0 }, // compound is topped up, energy is empty
        { UH: 0, energy: 2000 },
      ),
    });
    const storage = {
      id: 'stor1' as any,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000 }, 1000000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab') return boostLab;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab',
        boostCompound: 'UH',
      },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // Lab energy (0) < BOOST_LAB_ENERGY_TARGET (1000) → withdraw energy from storage
    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('delivers energy to boost lab when carrying energy and lab energy is below target', () => {
    const boostLab = mockLab('boostLab', {
      store: mockLabStore({ UH: 1500, energy: 0 }, { UH: 0, energy: 2000 }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab') return boostLab;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab',
        boostCompound: 'UH',
      },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'DELIVER' },
      store: mockStore({ energy: 200 }),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.transfer).toHaveBeenCalledWith(boostLab, RESOURCE_ENERGY);
  });

  it('does not activate boost lab logic when boostLabId is not set', () => {
    const storage = {
      id: 'stor1' as any,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, UH: 2000 }, 1000000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    // No boostLabId in memory
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // Should not withdraw UH (no boost lab configured) — only energy if needed
    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'UH', expect.anything());
  });

  it('does not activate boost lab logic when boostCompound is not set', () => {
    const boostLab = mockLab('boostLab', {
      store: mockLabStore({}, { energy: 2000 }),
    });
    const storage = {
      id: 'stor1' as any,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, UH: 2000 }, 1000000),
    };
    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab') return boostLab;
      return null;
    });
    // boostLabId is set but boostCompound is NOT set — must be inert
    (Memory as any).rooms = { W1N1: { boostLabId: 'boostLab' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(storage, 'UH', expect.anything());
  });

  it('withdraws wrong mineral from boost lab before loading GH2O (flush guard)', () => {
    // Boost lab was previously used for a reaction and holds 'OH' — the wrong compound.
    // The flush guard must withdraw 'OH' first so the lab can accept GH2O.
    const boostLab = mockLab('boostLab1', {
      mineralType: 'OH',
      store: mockLabStore({ OH: 800 }),
    });
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab1') return boostLab;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        id: 'stor1' as any,
        pos: new RoomPosition(26, 26, 'W1N1'),
        store: mockStore({ energy: 50000, GH2O: 2000 }, 1000000),
      },
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab1',
        boostCompound: 'GH2O',
      },
    };

    const creep = mockCreep({
      name: 'hauler_flush',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_flush: creep } as any;

    hauler.run(creep);

    // The flush guard should withdraw the wrong mineral ('OH') from the lab
    expect(creep.withdraw).toHaveBeenCalledWith(boostLab, 'OH');
  });

  it('loads GH2O into boost lab when lab is clean (no wrong mineral)', () => {
    // Boost lab is empty — no flush needed, should proceed to load GH2O from storage
    const boostLab = mockLab('boostLab2', {
      mineralType: null,
      store: mockLabStore({}),
    });
    const storage = {
      id: 'stor2' as any,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 50000, GH2O: 2000 }, 1000000),
    };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'boostLab2') return boostLab;
      if (id === 'stor2') return storage;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      storage,
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = {
      W1N1: {
        boostLabId: 'boostLab2',
        boostCompound: 'GH2O',
      },
    };

    const creep = mockCreep({
      name: 'hauler_load',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_load: creep } as any;

    hauler.run(creep);

    // No wrong mineral — should withdraw GH2O from storage to load the lab
    expect(creep.withdraw).toHaveBeenCalledWith(storage, 'GH2O', expect.any(Number));
  });
});

describe('hauler pool dispatcher integration', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    // Pool disabled by default
    (Memory as any).haulerPool = false;
  });

  // Helper: a container mock compatible with getStructuresByType (needs structureType)
  function poolContainer(id: string, energy: number, x: number, y: number): any {
    return {
      id,
      structureType: STRUCTURE_CONTAINER,
      pos: new RoomPosition(x, y, 'W1N1'),
      store: mockStore({ energy }, 2000),
    };
  }

  it('flag OFF: hauler picks the globally-fullest container (legacy behaviour unchanged)', () => {
    // cA (1900, far) is fullest; cB (1800, near hauler) is second.
    // Without pool the hauler picks cA (fullest-first).
    const cA = poolContainer('cA', 1900, 10, 10); // far from hauler
    const cB = poolContainer('cB', 1800, 40, 40); // near hauler

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [cA, cB];
        return [];
      }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'cA') return cA;
      if (id === 'cB') return cB;
      return null;
    });
    (Memory as any).rooms = { W1N1: {} };
    (Memory as any).haulerPool = false;

    const testHauler = mockCreep({
      name: 'h1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(38, 38, 'W1N1'), // near cB
    });
    // Add a second hauler so the pool (if it ran) would spread them
    const otherHauler = mockCreep({
      name: 'h2',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(12, 12, 'W1N1'), // near cA
    });
    (Game as any).creeps = { h1: testHauler, h2: otherHauler };

    hauler.run(testHauler);

    // Flag off → legacy fullest-first → testHauler picks cA (1900 energy)
    expect(testHauler.withdraw).toHaveBeenCalledWith(cA, RESOURCE_ENERGY);
    expect(testHauler.withdraw).not.toHaveBeenCalledWith(cB, RESOURCE_ENERGY);
  });

  it('flag ON: hauler uses the pool-assigned container even if not the globally-fullest', () => {
    // cA (1900, near h2) is globally fullest.
    // cB (1800, near h1/testHauler) is second.
    // Pool: round1 → cA (1900) highest, nearest hauler is h2 (near cA) → h2 assigned to cA.
    //        round2 → cB (1800) now highest remaining, nearest hauler is h1 → h1 assigned to cB.
    // testHauler (h1) should withdraw from cB, NOT cA.
    const cA = poolContainer('cA', 1900, 10, 10); // near h2
    const cB = poolContainer('cB', 1800, 40, 40); // near h1 (testHauler)

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [cA, cB];
        return [];
      }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'cA') return cA;
      if (id === 'cB') return cB;
      return null;
    });
    (Memory as any).rooms = { W1N1: {} };
    (Memory as any).haulerPool = true;

    const testHauler = mockCreep({
      name: 'h1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(38, 38, 'W1N1'), // near cB
    });
    const otherHauler = mockCreep({
      name: 'h2',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(12, 12, 'W1N1'), // near cA
    });
    (Game as any).creeps = { h1: testHauler, h2: otherHauler };

    hauler.run(testHauler);

    // Pool assigned h1 → cB (pool spreads haulers vs both converging on cA)
    expect(testHauler.withdraw).toHaveBeenCalledWith(cB, RESOURCE_ENERGY);
    expect(testHauler.withdraw).not.toHaveBeenCalledWith(cA, RESOURCE_ENERGY);
  });

  it('flag ON: falls through to legacy logic when hauler has no pool assignment', () => {
    // Only one container (cA), two haulers. Pool assigns h2 (nearest) to cA.
    // h1 has no assignment → falls through to legacy logic → still picks cA (only container).
    const cA = poolContainer('cA', 1500, 10, 10);

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [cA];
        return [];
      }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'cA') return cA;
      return null;
    });
    (Memory as any).rooms = { W1N1: {} };
    (Memory as any).haulerPool = true;

    const testHauler = mockCreep({
      name: 'h1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(30, 30, 'W1N1'),
    });
    const otherHauler = mockCreep({
      name: 'h2',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(11, 11, 'W1N1'), // nearest to cA → pool assigns h2 to cA
    });
    (Game as any).creeps = { h1: testHauler, h2: otherHauler };

    hauler.run(testHauler);

    // h1 has no assignment (pool only needed one hauler for cA, h2 was nearest).
    // Falls through to legacy sorted selection → still picks cA (only container).
    expect(testHauler.withdraw).toHaveBeenCalledWith(cA, RESOURCE_ENERGY);
  });

  it('flag ON: falls through to legacy fullest-first when pool-assigned container is empty', () => {
    // Pool assigns h1 → cB (h2 nearest to cA wins round1; h1 gets cB in round2).
    // Game.getObjectById('cB') returns 0 energy (race: drained between pool compute and check).
    // Pool check falls through → legacy fullest-first picks cA (1500, first in room.find order).
    const cA = poolContainer('cA', 1500, 10, 10); // 'cA' < 'cB' → wins round1 id tie
    const cB = poolContainer('cB', 1500, 40, 40); // near testHauler (h1) → h1 gets cB

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_STRUCTURES) return [cA, cB];
        return [];
      }),
    });

    // cB via getObjectById is empty (race condition); cA still has energy
    const emptyCB = { id: 'cB', store: mockStore({}, 2000) }; // 0 energy
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'cA') return cA;
      if (id === 'cB') return emptyCB;
      return null;
    });
    (Memory as any).rooms = { W1N1: {} };
    (Memory as any).haulerPool = true;

    const testHauler = mockCreep({
      name: 'h1',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(38, 38, 'W1N1'), // near cB
    });
    const otherHauler = mockCreep({
      name: 'h2',
      room,
      memory: { role: 'hauler', state: 'PICKUP', homeRoom: 'W1N1' },
      store: mockStore({}),
      pos: new RoomPosition(12, 12, 'W1N1'), // near cA → gets cA in round1
    });
    (Game as any).creeps = { h1: testHauler, h2: otherHauler };

    hauler.run(testHauler);

    // Pool assigned h1 → cB, but cB returns 0 energy from getObjectById → falls through.
    // Legacy fullest-first: getStructuresByType returns original cA (1500 ≥ 1000), picks cA.
    // Note: creep.withdraw is called with the object from room.find (cA), not from getObjectById.
    expect(testHauler.withdraw).toHaveBeenCalledWith(cA, RESOURCE_ENERGY);
    expect(testHauler.withdraw).not.toHaveBeenCalledWith(emptyCB, RESOURCE_ENERGY);
  });
});

// ---------------------------------------------------------------------------
// pickupForeignStore — direct withdrawal from reclaimed-room foreign store
// ---------------------------------------------------------------------------

describe('hauler pickupForeignStore', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('withdraws energy from a foreign storage when lootTargetId is set and store has energy', () => {
    const foreignStorage = {
      id: 'fStorage' as any,
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: mockStore({ energy: 100_000 }, 1_000_000),
    };

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'fStorage') return foreignStorage;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    (Memory as any).rooms = { W1N1: { lootTargetId: 'fStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(foreignStorage, RESOURCE_ENERGY);
  });

  it('returns false (skips) when lootTargetId is not set', () => {
    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });
    (Memory as any).rooms = { W1N1: {} };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // No foreign store pickup attempted
    // (the test just verifies no crash and creep can still idle)
    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('returns false (skips) when loot target store is empty', () => {
    const emptyStorage = {
      id: 'fStorage' as any,
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: mockStore({}, 1_000_000),
    };

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'fStorage') return emptyStorage;
      return null;
    });

    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });
    (Memory as any).rooms = { W1N1: { lootTargetId: 'fStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(emptyStorage, RESOURCE_ENERGY);
  });

  it('returns false (skips) when loot target is gone (getObjectById returns null)', () => {
    (Game as any).getObjectById = vi.fn(() => null);

    const room = mockRoom({ name: 'W1N1', find: vi.fn(() => []) });
    (Memory as any).rooms = { W1N1: { lootTargetId: 'goneStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('skips mineral when no own storage or terminal present (avoids trapping mineral in hauler)', () => {
    // Foreign storage holds only a mineral (no energy). Room has no OWN storage/terminal.
    const foreignStorage = {
      id: 'fStorage' as any,
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      // Add store with H but no energy
      store: {
        getUsedCapacity: vi.fn((r?: string) => {
          if (r === undefined) return 5000;
          if (r === RESOURCE_ENERGY) return 0;
          if (r === 'H') return 5000;
          return 0;
        }),
        getFreeCapacity: vi.fn(() => 995000),
      },
    };
    // Override Object.keys for this store to return ['H']
    Object.defineProperty(foreignStorage.store, Symbol.iterator, { value: undefined });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'fStorage') return foreignStorage;
      return null;
    });

    // No own storage (storage is undefined), no terminal
    const room = mockRoom({
      name: 'W1N1',
      storage: undefined,
      find: vi.fn(() => []),
    });
    (Memory as any).rooms = { W1N1: { lootTargetId: 'fStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // No mineral should be withdrawn when there's no own store to deliver to
    expect(creep.withdraw).not.toHaveBeenCalledWith(foreignStorage, 'H');
  });

  it('picks mineral from foreign store when own storage is present', () => {
    // Foreign storage holds only a mineral (no energy). Room has OWN storage.
    const foreignStorage = {
      id: 'fStorage' as any,
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: {
        getUsedCapacity: vi.fn((r?: string) => {
          if (r === undefined) return 5000;
          if (r === RESOURCE_ENERGY) return 0;
          if (r === 'H') return 5000;
          return 0;
        }),
        getFreeCapacity: vi.fn(() => 995000),
      },
    };
    // Make Object.keys(foreignStorage.store) return ['H']
    const storeProxy = new Proxy(foreignStorage.store, {
      ownKeys: () => ['H'],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    foreignStorage.store = storeProxy as any;

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'fStorage') return foreignStorage;
      return null;
    });

    const ownStorage = {
      my: true,
      pos: new RoomPosition(16, 28, 'W1N1'),
      store: mockStore({ energy: 50000 }, 1_000_000),
    };

    const room = mockRoom({
      name: 'W1N1',
      storage: ownStorage,
      find: vi.fn(() => []),
    });
    (Memory as any).rooms = { W1N1: { lootTargetId: 'fStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(foreignStorage, 'H');
  });

  it('drains a full source container before the foreign storage', () => {
    // Priority: a non-decaying foreign hoard must not preempt emptying a full
    // (near-overflow) source container — fresh miner income comes first.
    const fullContainer = {
      id: 'cSrc' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      store: mockStore({ energy: 1500 }, 2000),
      pos: new RoomPosition(8, 15, 'W1N1'),
    };
    const foreignStorage = {
      id: 'fStorage' as any,
      my: false,
      pos: new RoomPosition(20, 20, 'W1N1'),
      store: mockStore({ energy: 100_000 }, 1_000_000),
    };
    (Game as any).getObjectById = vi.fn((id: string) =>
      id === 'fStorage' ? foreignStorage : null,
    );
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((_type: number, opts?: any) => {
        const all = [fullContainer];
        return opts?.filter ? all.filter(opts.filter) : all;
      }),
    });
    (Memory as any).rooms = { W1N1: { lootTargetId: 'fStorage' } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(fullContainer, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(foreignStorage, RESOURCE_ENERGY);
  });
});

describe('pickupFeederLabs', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  /**
   * Set up a two-room world where W3N3 is the hub (6 labs) and W1N1 is the
   * feeder (3 labs). Returns the feeder room object.
   */
  function setupFeederWorld(feederLabIds: string[]): any {
    const hubRoom = mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } });
    const feederRoom = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    (Game as any).rooms = { W1N1: feederRoom, W3N3: hubRoom };
    (Memory as any).rooms = {
      W1N1: {
        labIds: feederLabIds,
        inputLabIds: feederLabIds.slice(0, 2),
        // stale reaction from before W1N1 became a feeder — runLabs would have
        // cleared this, but we explicitly clear it here to simulate post-runLabs state
        // (pickupFeederLabs must not rely on runLabs having already run in the same tick)
        activeReaction: undefined,
      },
      W3N3: { labIds: ['a', 'b', 'c', 'd', 'e', 'f'] },
    };
    return feederRoom;
  }

  it('withdraws mineral from a feeder input lab that holds stale mineral', () => {
    const inputLab = mockLab('lab1', {
      mineralType: 'Z',
      store: mockLabStore({ Z: 2445 }),
    });
    const emptyLab2 = mockLab('lab2');
    const emptyLab3 = mockLab('lab3');

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab;
      if (id === 'lab2') return emptyLab2;
      if (id === 'lab3') return emptyLab3;
      return null;
    });

    const feederRoom = setupFeederWorld(['lab1', 'lab2', 'lab3']);

    const creep = mockCreep({
      name: 'hauler_1',
      room: feederRoom,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(inputLab, 'Z');
  });

  it('returns false and does nothing in a hub room', () => {
    // W1N1 has 6 labs → it IS the hub; pickupFeederLabs must not fire there.
    const lab = mockLab('lab1', {
      mineralType: 'H',
      store: mockLabStore({ H: 500 }),
    });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return lab;
      return null;
    });

    const hubRoom = mockRoom({ name: 'W1N1', controller: { my: true, level: 7 } });
    const feederRoom = mockRoom({ name: 'W3N3', controller: { my: true, level: 6 } });
    (Game as any).rooms = { W1N1: hubRoom, W3N3: feederRoom };
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'x2', 'x3', 'x4', 'x5', 'x6'], inputLabIds: ['lab1', 'x2'] },
      W3N3: { labIds: ['lab1', 'x2', 'x3'] },
    };

    // Hauler is in the HUB room (W1N1)
    const creep = mockCreep({
      name: 'hauler_1',
      room: hubRoom,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // Hub hauler must not use pickupFeederLabs (hub manages its own labs differently)
    expect(creep.withdraw).not.toHaveBeenCalledWith(lab, 'H');
  });

  it('returns false when all feeder labs are empty', () => {
    const emptyLab1 = mockLab('lab1');
    const emptyLab2 = mockLab('lab2');

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return emptyLab1;
      if (id === 'lab2') return emptyLab2;
      return null;
    });

    const feederRoom = setupFeederWorld(['lab1', 'lab2']);

    const storage = {
      my: true,
      pos: new RoomPosition(26, 26, 'W1N1'),
      store: mockStore({ energy: 10000 }, 1000000),
    };
    (feederRoom as any).storage = storage;
    // Hauler with energy goes to deliver normally (no lab task)
    const creep = mockCreep({
      name: 'hauler_1',
      room: feederRoom,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // Neither empty lab should be withdrawn from
    expect(creep.withdraw).not.toHaveBeenCalledWith(emptyLab1, expect.anything());
    expect(creep.withdraw).not.toHaveBeenCalledWith(emptyLab2, expect.anything());
  });

  it('does not fire when there is no hub (single-room empire)', () => {
    // No hub room exists (Game.rooms has only one room, no labIds set) →
    // getLabHubName returns undefined → pickupFeederLabs returns false.
    const lab = mockLab('lab1', {
      mineralType: 'H',
      store: mockLabStore({ H: 500 }),
    });
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return lab;
      return null;
    });

    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 7 } });
    // Only one room in Game.rooms, and no labIds set → no hub detected
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3'], inputLabIds: ['lab1', 'lab2'] },
    };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    Game.creeps = { hauler_1: creep } as any;

    hauler.run(creep);

    // No hub → pickupFeederLabs is a no-op; lab should not be drained this way
    expect(creep.withdraw).not.toHaveBeenCalledWith(lab, 'H');
  });
});

describe('pickupTerminalEnergyToStorage', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    (Memory as any).holisticEconomy = true;
  });

  afterEach(() => {
    delete (Memory as any).holisticEconomy;
  });

  function makeStorage(energy: number): any {
    return {
      id: 'storage1' as any,
      my: true,
      store: mockStore({ energy }),
    };
  }

  function makeTerminal(energy: number): any {
    return {
      id: 'terminal1' as any,
      my: true,
      store: mockStore({ energy }),
      cooldown: 0,
    };
  }

  it('withdraws from terminal when storage is below upgradeBuffer and terminal has surplus', () => {
    // RCL6 upgradeBuffer = 25_000; storage 10k < 25k → deficit
    // terminal 30k > 15k (floor) + 2k (min batch) → surplus
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(10_000);
    const terminal = makeTerminal(30_000);
    room.storage = storage;
    room.terminal = terminal;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, expect.any(Number));
  });

  it('does not withdraw when flag is off', () => {
    delete (Memory as any).holisticEconomy;
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(5_000);
    const terminal = makeTerminal(30_000);
    room.storage = storage;
    room.terminal = terminal;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, expect.any(Number));
  });

  it('does not withdraw when storage is healthy (at or above upgradeBuffer)', () => {
    // RCL6 upgradeBuffer = 25_000; storage 25k → healthy, no restock needed
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(25_000);
    const terminal = makeTerminal(40_000);
    room.storage = storage;
    room.terminal = terminal;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, expect.any(Number));
  });

  it('does not withdraw when terminal surplus is below the minimum batch threshold', () => {
    // terminal 16k — only 1k above the 15k floor, below TERMINAL_RESTOCK_MIN_BATCH (2k)
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(5_000);
    const terminal = makeTerminal(16_000);
    room.storage = storage;
    room.terminal = terminal;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY, expect.any(Number));
  });

  it('never drains terminal below the energy floor', () => {
    // terminal 20k: surplus = 20k - 15k (floor) = 5k available. Creep carry 800.
    // withdraw amount should be min(800, 5000) = 800, not the full 20k.
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(5_000);
    const terminal = makeTerminal(20_000);
    room.storage = storage;
    room.terminal = terminal;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    // The amount passed to withdraw must be ≤ terminal surplus above floor (5000)
    const withdrawCall = (creep.withdraw as any).mock.calls.find(
      (args: any[]) => args[0] === terminal && args[1] === RESOURCE_ENERGY,
    );
    expect(withdrawCall).toBeDefined();
    const amount = withdrawCall[2] as number;
    expect(amount).toBeLessThanOrEqual(5_000);
    expect(amount).toBeGreaterThan(0);
  });

  it('does not withdraw when no own terminal exists', () => {
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    const storage = makeStorage(5_000);
    room.storage = storage;
    room.terminal = undefined;
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const creep = mockCreep({
      name: 'hauler_1',
      room,
      memory: { role: 'hauler', state: 'PICKUP' },
      store: mockStore({}, 800),
      pos: new RoomPosition(25, 25, 'W1N1'),
    });
    (Game as any).creeps = { hauler_1: creep };

    hauler.run(creep);

    expect(creep.withdraw).not.toHaveBeenCalledWith(
      expect.anything(),
      RESOURCE_ENERGY,
      expect.any(Number),
    );
  });
});
