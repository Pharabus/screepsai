import { runLabs } from '../../src/managers/labs';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function mockLab(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? 'lab1',
    structureType: STRUCTURE_LAB,
    cooldown: overrides.cooldown ?? 0,
    mineralType: overrides.mineralType ?? null,
    store: {
      getUsedCapacity: vi.fn((r?: string) => {
        if (r && overrides.stored?.[r] !== undefined) return overrides.stored[r];
        return 0;
      }),
      getFreeCapacity: vi.fn((r?: string) => {
        if (r && overrides.capacity?.[r] !== undefined) return overrides.capacity[r];
        return 3000;
      }),
    },
    runReaction: vi.fn(() => OK),
    ...overrides,
  };
}

function setupRoom(
  rcl: number,
  labSetup: { labIds: string[]; inputLabIds: [string, string]; activeReaction?: any },
): any {
  const room = mockRoom({
    name: 'W1N1',
    controller: { my: true, level: rcl },
    storage: {
      store: {
        getUsedCapacity: vi.fn(() => 10000),
        [Symbol.iterator]: function* () {
          yield ['H', 5000];
          yield ['O', 5000];
        },
      },
    },
    terminal: {
      store: {
        getUsedCapacity: vi.fn(() => 0),
        getFreeCapacity: vi.fn(() => 100000),
        [Symbol.iterator]: function* () {},
      },
    },
  });

  (Memory as any).rooms = {
    W1N1: {
      labIds: labSetup.labIds,
      inputLabIds: labSetup.inputLabIds,
      activeReaction: labSetup.activeReaction,
    },
  };

  (Game as any).rooms = { W1N1: room };
  return room;
}

describe('runLabs', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('does nothing when no labs are configured', () => {
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: {} };

    runLabs();
    // No error thrown
  });

  it('does nothing when fewer than 3 labs exist', () => {
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { labIds: ['lab1', 'lab2'] } };

    runLabs();
    // No error thrown
  });

  it('does nothing when input labs are missing', () => {
    const room = mockRoom({ name: 'W1N1', controller: { my: true, level: 6 } });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = { W1N1: { labIds: ['lab1', 'lab2', 'lab3'] } };

    runLabs();
    // No error thrown — no inputLabIds set
  });

  it('runs reactions on output labs when inputs are loaded', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    expect(outputLab.runReaction).toHaveBeenCalledWith(inputLab1, inputLab2);
  });

  it('skips output labs on cooldown', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', cooldown: 5, capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    expect(outputLab.runReaction).not.toHaveBeenCalled();
  });

  it('skips reaction when input lab has insufficient minerals', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 2 } }); // < LAB_REACTION_AMOUNT (5)
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    expect(outputLab.runReaction).not.toHaveBeenCalled();
  });

  it('does not run reactions on input labs', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    expect(inputLab1.runReaction).not.toHaveBeenCalled();
    expect(inputLab2.runReaction).not.toHaveBeenCalled();
  });

  it('skips output lab when output is full', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 0 } }); // full

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    expect(outputLab.runReaction).not.toHaveBeenCalled();
  });

  it('sets labFlushing when reaction changes and labs hold minerals with no viable reaction', () => {
    // Labs hold K and L — these don't combine, so the stickiness path fails
    // and the selector falls through to the goal/greedy logic. Storage has
    // Z+K, so ZK is chosen; lab1 (K) and lab2 (L) don't match Z+K → flush.
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'K', stored: { K: 500 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'L', stored: { L: 500 } });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    const storageResources: Record<string, number> = { Z: 1000, K: 1000 };
    const storageStore: Record<string, any> = { ...storageResources };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storageResources[r] ?? 0) : 0)),
    });

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: { store: storageStore },
      terminal: null,
    });
    (Game as any).rooms = { W1N1: room };
    // Force re-evaluation by setting time to a multiple of 500
    (Game as any).time = 500;
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    expect(mem?.activeReaction?.output).toBe('ZK');
    expect(mem?.labFlushing).toBe(true);
  });

  it('clears labFlushing when input labs are empty of stale minerals', () => {
    const inputLab1 = mockLab({ id: 'lab1', mineralType: null, stored: {} });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: null, stored: {} });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    (Memory.rooms['W1N1'] as any).labFlushing = true;

    runLabs();

    expect(Memory.rooms['W1N1']?.labFlushing).toBe(false);
  });

  it('skips reactions while labFlushing is true and labs still have stale minerals', () => {
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'L', stored: { L: 500 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'O', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { LH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    (Memory.rooms['W1N1'] as any).labFlushing = true;

    runLabs();

    expect(outputLab.runReaction).not.toHaveBeenCalled();
    // labFlushing should remain true because lab1 has 'L' not 'H'
    expect(Memory.rooms['W1N1']?.labFlushing).toBe(true);
  });

  it('prefers a reaction matching current lab contents to avoid flushing', () => {
    // Input labs hold H and O — sticky should pick OH = H + O even though
    // storage also has Z/K available for ZK (which the goal chain might
    // otherwise prefer).
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'H', stored: { H: 500 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'O', stored: { O: 500 } });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    const storageStore: Record<string, any> = { Z: 5000, K: 5000, H: 100, O: 100 };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storageStore[r] ?? 0) : 0)),
    });
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: { store: storageStore },
      terminal: null,
    });
    (Game as any).rooms = { W1N1: room };
    (Game as any).time = 500; // force re-evaluation
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'Z', input2: 'K', output: 'ZK' },
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    expect(mem?.activeReaction?.output).toBe('OH');
    expect(mem?.labFlushing).toBeFalsy();
  });

  it('does not stick to a residue reaction when supplies are exhausted', () => {
    // Labs have residual H+O but storage/terminal are dry of both →
    // sticky should fail and fall through to whatever the goal chain picks.
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'H', stored: { H: 50 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'O', stored: { O: 50 } });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    const storageStore: Record<string, any> = { Z: 5000, K: 5000 };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storageStore[r] ?? 0) : 0)),
    });
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: { store: storageStore },
      terminal: null,
    });
    (Game as any).rooms = { W1N1: room };
    (Game as any).time = 500;
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    // Sticky requires MIN_INPUT_AMOUNT (100) of each — H+O total = 50+50 = 100
    // but each individually is 50 in the lab + 0 in storage = 50 < 100,
    // so fall through to ZK.
    expect(mem?.activeReaction?.output).toBe('ZK');
  });

  it('selects a reaction when none is active', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: {} });
    const inputLab2 = mockLab({ id: 'lab2', stored: {} });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: {
        store: Object.assign(
          { H: 1000, O: 1000 },
          {
            getUsedCapacity: vi.fn(() => 0),
            [Symbol.iterator]: function* () {
              yield ['H', 1000];
              yield ['O', 1000];
            },
          },
        ),
      },
      terminal: {
        store: {
          getUsedCapacity: vi.fn(() => 0),
          getFreeCapacity: vi.fn(() => 100000),
          [Symbol.iterator]: function* () {},
        },
      },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    expect(mem?.activeReaction).toBeDefined();
    expect(mem?.activeReaction?.output).toBe('OH');
  });
});
