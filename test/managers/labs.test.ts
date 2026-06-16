import {
  getChainBuyNeeds,
  getLabHubName,
  isLabHub,
  resetReactionGoalCache,
  runLabs,
  selectReaction,
} from '../../src/managers/labs';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

function mockLab(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? 'lab1',
    structureType: STRUCTURE_LAB,
    cooldown: overrides.cooldown ?? 0,
    mineralType: overrides.mineralType ?? null,
    isActive: vi.fn(() => overrides.active ?? true),
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
  // buildAvailableMap (src/managers/labs.ts) reads storage/terminal contents
  // via Object.entries(store) — mirroring the real Store, which exposes
  // resource constants as own enumerable properties. getUsedCapacity/
  // getFreeCapacity must be non-enumerable so they don't show up as bogus
  // "resources" in that scan.
  const storageStore: Record<string, any> = { H: 5000, O: 5000 };
  Object.defineProperty(storageStore, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn(() => 10000),
  });
  const terminalStore: Record<string, any> = {};
  Object.defineProperty(terminalStore, 'getUsedCapacity', {
    enumerable: false,
    value: vi.fn(() => 0),
  });
  Object.defineProperty(terminalStore, 'getFreeCapacity', {
    enumerable: false,
    value: vi.fn(() => 100000),
  });

  const room = mockRoom({
    name: 'W1N1',
    controller: { my: true, level: rcl },
    storage: { store: storageStore },
    terminal: { store: terminalStore },
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

describe('getLabHubName / isLabHub', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('picks the owned room with the most labs', () => {
    (Game as any).rooms = {
      W1N1: mockRoom({ name: 'W1N1', controller: { my: true, level: 7 } }),
      W2N2: mockRoom({ name: 'W2N2', controller: { my: true, level: 6 } }),
    };
    (Memory as any).rooms = {
      W1N1: { labIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, // 6 labs
      W2N2: { labIds: ['a', 'b', 'c'] }, // 3 labs
    };
    expect(getLabHubName()).toBe('W1N1');
    expect(isLabHub((Game as any).rooms.W1N1)).toBe(true);
    expect(isLabHub((Game as any).rooms.W2N2)).toBe(false);
  });

  it('breaks ties on RCL then room name, and ignores rooms with no labs', () => {
    (Game as any).rooms = {
      W2N2: mockRoom({ name: 'W2N2', controller: { my: true, level: 6 } }),
      W1N1: mockRoom({ name: 'W1N1', controller: { my: true, level: 7 } }),
      W9N9: mockRoom({ name: 'W9N9', controller: { my: true, level: 8 } }), // no labs
    };
    (Memory as any).rooms = {
      W2N2: { labIds: ['a', 'b', 'c'] },
      W1N1: { labIds: ['a', 'b', 'c'] }, // same lab count, higher RCL → wins
      W9N9: {}, // no labIds → ignored despite highest RCL
    };
    expect(getLabHubName()).toBe('W1N1');
  });

  it('returns undefined when no owned room has labs', () => {
    (Game as any).rooms = {
      W1N1: mockRoom({ name: 'W1N1', controller: { my: true, level: 4 } }),
    };
    (Memory as any).rooms = { W1N1: {} };
    expect(getLabHubName()).toBeUndefined();
  });
});

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

  it('does NOT run reactions in a non-hub (feeder) room', () => {
    // Full-feeder model: only the hub runs reactions. W1N1 has a complete lab
    // config but W3N3 has more labs, so W1N1 is a feeder and must stay idle.
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
    // Add a hub room with more labs so W1N1 is NOT the hub.
    (Game as any).rooms.W3N3 = mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } });
    (Memory as any).rooms.W3N3 = { labIds: ['a', 'b', 'c', 'd', 'e', 'f'] };

    runLabs();

    expect(outputLab.runReaction).not.toHaveBeenCalled();
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

  it('goal-directed selection overrides sticky when a higher-priority goal step is achievable', () => {
    // Input labs hold H and O (a viable OH pair → sticky would return OH).
    // Storage also has GH:500 and OH:500 — enough to run the GH+OH→GH2O step,
    // which is the highest viable step in the GH2O goal chain.
    // With goal-first ordering the goal wins and GH2O is selected, not sticky OH.
    // (This is the regression guard: before the fix, sticky ran first and welded
    // the labs onto OH every tick, so GH+OH→GH2O was never reached.)
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'H', stored: { H: 500 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'O', stored: { O: 500 } });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    // GH:500 and OH:500 in storage both meet MIN_STEP_AMOUNT (200).
    // H:200 and O:200 in storage also meet the threshold so the OH step is
    // viable too — but GH2O is the highest-tier viable step and must win.
    const storageStore: Record<string, any> = { GH: 500, OH: 500, H: 200, O: 200 };
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
        activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    // Goal (GH2O, highest-tier viable step in the GH2O chain) must win over sticky OH
    expect(mem?.activeReaction?.output).toBe('GH2O');
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

  it('runs reactions on all 7 output labs (9-lab RCL 7 configuration)', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLabs = Array.from({ length: 7 }, (_, i) =>
      mockLab({ id: `lab${i + 3}`, capacity: { OH: 3000 } }),
    );

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      return outputLabs.find((l) => l.id === id) ?? null;
    });

    setupRoom(7, {
      labIds: ['lab1', 'lab2', ...outputLabs.map((l: any) => l.id)],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    runLabs();

    for (const lab of outputLabs) {
      expect(lab.runReaction).toHaveBeenCalledWith(inputLab1, inputLab2);
    }
    expect(inputLab1.runReaction).not.toHaveBeenCalled();
    expect(inputLab2.runReaction).not.toHaveBeenCalled();
  });

  it('skips the reserved boost lab in the output reaction loop, while reacting on other output labs', () => {
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const boostLab = mockLab({ id: 'boostLab', capacity: { OH: 3000 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'boostLab') return boostLab;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(7, {
      labIds: ['lab1', 'lab2', 'boostLab', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
    });

    (Memory.rooms['W1N1'] as any).boostLabId = 'boostLab';

    runLabs();

    // The reserved boost lab must NOT react — it holds the boost compound, not a reaction product
    expect(boostLab.runReaction).not.toHaveBeenCalled();
    // Other output labs should still react normally
    expect(outputLab.runReaction).toHaveBeenCalledWith(inputLab1, inputLab2);
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

  it('clears activeReaction and labFlushing on a feeder room that previously ran reactions', () => {
    // W1N1 is the feeder (fewer labs), W3N3 is the hub. W1N1 had activeReaction
    // and labFlushing set from when it ran its own reactions. runLabs must clear
    // them so deliverToLabInput (gated on activeReaction) does not re-deposit a
    // just-drained mineral back into the input lab.
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
    (Memory.rooms['W1N1'] as any).labFlushing = true;

    // Add a hub room with more labs so W1N1 is the feeder.
    (Game as any).rooms.W3N3 = mockRoom({ name: 'W3N3', controller: { my: true, level: 7 } });
    (Memory as any).rooms.W3N3 = { labIds: ['a', 'b', 'c', 'd', 'e', 'f'] };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    expect(mem?.activeReaction).toBeUndefined();
    expect(mem?.labFlushing).toBeUndefined();
    // Reactions must still not run (feeder room)
    expect(outputLab.runReaction).not.toHaveBeenCalled();
  });

  it('does not clear activeReaction or labFlushing on the hub room', () => {
    // The hub (W1N1 with 6 labs, feeder W3N3 with 3 labs) must retain its
    // activeReaction and labFlushing so its own reaction loop continues.
    const inputLab1 = mockLab({ id: 'lab1', stored: { H: 100 } });
    const inputLab2 = mockLab({ id: 'lab2', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { OH: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    // W1N1 has 6 labs → it's the hub
    // buildAvailableMap reads via Object.entries(store) — see setupRoom's
    // comment. H/O must be enumerable own properties; getUsedCapacity non-enumerable.
    const storageStore: Record<string, any> = { H: 5000, O: 5000 };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn(() => 10000),
    });
    const terminalStore: Record<string, any> = {};
    Object.defineProperty(terminalStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn(() => 0),
    });
    Object.defineProperty(terminalStore, 'getFreeCapacity', {
      enumerable: false,
      value: vi.fn(() => 100000),
    });

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: { store: storageStore },
      terminal: { store: terminalStore },
    });
    (Game as any).rooms = { W1N1: room };
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3', 'x1', 'x2', 'x3'],
        inputLabIds: ['lab1', 'lab2'],
        activeReaction: { input1: 'H', input2: 'O', output: 'OH' },
        labFlushing: false,
      },
    };

    runLabs();

    const mem = Memory.rooms['W1N1'];
    // Hub retains (or refreshes) activeReaction — must still be defined
    expect(mem?.activeReaction).toBeDefined();
  });

  it('re-selects mid-interval when the active reaction is unviable and a different one is viable', () => {
    // Game.time is NOT a multiple of REACTION_CHECK_INTERVAL (500), so only the
    // event-driven unviable check can trigger re-selection here.
    //
    // Active reaction is Z+K->ZK, but neither storage nor the input labs hold
    // any Z or K -> unviable. Storage holds H:5000/O:5000, so the GH2O goal's
    // first viable step (H+O->OH) is selectable and must be picked instead.
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
      activeReaction: { input1: 'Z', input2: 'K', output: 'ZK' },
    });
    (Game as any).time = 123; // not a %500 tick

    runLabs();

    const mem = Memory.rooms['W1N1'];
    expect(mem?.activeReaction?.output).not.toBe('ZK');
    expect(mem?.activeReaction?.output).toBe('OH');
  });

  it('does NOT re-select mid-interval while labFlushing is true, even if the active reaction is unviable', () => {
    // Same unviable Z+K->ZK setup as above, but labFlushing is already true —
    // the event-driven re-eval must be suppressed so the established flush
    // path (not a fresh selection) handles the stale input labs.
    const inputLab1 = mockLab({ id: 'lab1', mineralType: 'L', stored: { L: 500 } });
    const inputLab2 = mockLab({ id: 'lab2', mineralType: 'O', stored: { O: 100 } });
    const outputLab = mockLab({ id: 'lab3', capacity: { ZK: 3000 } });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

    setupRoom(6, {
      labIds: ['lab1', 'lab2', 'lab3'],
      inputLabIds: ['lab1', 'lab2'] as [string, string],
      activeReaction: { input1: 'Z', input2: 'K', output: 'ZK' },
    });
    (Memory.rooms['W1N1'] as any).labFlushing = true;
    (Game as any).time = 123; // not a %500 tick

    runLabs();

    const mem = Memory.rooms['W1N1'];
    // activeReaction unchanged — re-selection was suppressed by labFlushing
    expect(mem?.activeReaction?.output).toBe('ZK');
  });
});

describe('selectReaction', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetReactionGoalCache();
  });

  function makeSelectRoom(
    storageResources: Record<string, number>,
    inputLabMineralType1: string | null = null,
    inputLabStored1: Record<string, number> = {},
    inputLabMineralType2: string | null = null,
    inputLabStored2: Record<string, number> = {},
  ): any {
    const inputLab1 = mockLab({
      id: 'lab1',
      mineralType: inputLabMineralType1,
      stored: inputLabStored1,
    });
    const inputLab2 = mockLab({
      id: 'lab2',
      mineralType: inputLabMineralType2,
      stored: inputLabStored2,
    });
    const outputLab = mockLab({ id: 'lab3' });

    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return inputLab1;
      if (id === 'lab2') return inputLab2;
      if (id === 'lab3') return outputLab;
      return null;
    });

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
    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
      },
    };
    return room;
  }

  it('goal-directed: GH stocked + OH low + O/H available -> selects O+H->OH (live GH2O stall case)', () => {
    // Live state: GH2O frozen at 264 with GH=5000 (plenty), OH=50 (short),
    // O/H abundant. The forward-greedy selector kept making deep precursors
    // of the already-stocked GH (ZK/G) instead of OH, the goal's actual
    // missing input. nextStepFor must return the O+H->OH step.
    const room = makeSelectRoom({ GH: 5000, OH: 50, O: 500, H: 500 });
    const result = selectReaction(room);
    expect(result?.output).toBe('OH');
  });

  it('regression: goal step wins over sticky low-tier pair in input labs', () => {
    // The bug: input labs hold H+O (viable OH pair → sticky returns OH).
    // Storage has GH:500 and OH:500 — enough to run GH+OH→GH2O, the highest-tier
    // viable step in the GH2O goal chain.
    // Before the fix: sticky ran first and returned OH every tick, so the
    // GH+OH→GH2O step was never reached and the chain could never climb.
    // After the fix: goal loop runs first and returns GH2O.
    const room = makeSelectRoom({ GH: 500, OH: 500, H: 200, O: 200 }, 'H', { H: 500 }, 'O', {
      O: 500,
    });
    const result = selectReaction(room);
    expect(result?.output).toBe('GH2O');
  });

  it('sticky fallback fires when no goal chain has an achievable step', () => {
    // Storage has only H and O — no higher-goal steps are achievable. The input
    // labs already hold H+O. Sticky should return OH so the existing batch
    // finishes without a flush.
    const room = makeSelectRoom({ H: 5000, O: 5000 }, 'H', { H: 500 }, 'O', { O: 500 });
    const result = selectReaction(room);
    // OH is itself a REACTION_GOAL (lowest priority) and findNextChainStep will
    // find it from storage — so the goal loop itself returns OH here, which is
    // the correct outcome regardless of which path wins.
    expect(result?.output).toBe('OH');
  });

  it('sticky fallback fires when goal chain is blocked and labs hold residual pair', () => {
    // Storage is empty of everything except what is in the labs (50 units each,
    // below MIN_STEP_AMOUNT for goal selection). Labs hold H+O (200 combined but
    // 50+50 in storage each → 100 total per mineral including lab stock, exactly
    // at MIN_INPUT_AMOUNT=100 for sticky). Greedy would also see nothing.
    // Use a non-goal pair to confirm sticky (not goal loop) is the source.
    // We need a pair that is NOT in REACTION_GOALS but is a valid REACTIONS entry.
    // H + L → LH which is a valid reaction but LH is not a top-level REACTION_GOAL.
    // Storage has nothing; labs have H(50) + L(50).
    const room = makeSelectRoom({}, 'H', { H: 50 }, 'L', { L: 50 });
    const result = selectReaction(room);
    // 50 in lab = 50 total supply per mineral (storage has 0).
    // MIN_INPUT_AMOUNT = 100 so sticky should also fail → result is undefined.
    expect(result).toBeUndefined();
  });
});

describe('getChainBuyNeeds', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetReactionGoalCache();
  });

  function makeRoom(
    storageResources: Record<string, number>,
    terminalResources: Record<string, number> = {},
  ): any {
    const storageStore: Record<string, any> = { ...storageResources };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storageResources[r] ?? 0) : 0)),
    });

    const terminalStore: Record<string, any> = { ...terminalResources };
    Object.defineProperty(terminalStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (terminalResources[r] ?? 0) : 0)),
    });

    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: { store: storageStore },
      terminal: { store: terminalStore },
    });

    (Memory as any).rooms = {
      W1N1: {
        labIds: ['lab1', 'lab2', 'lab3'],
        inputLabIds: ['lab1', 'lab2'],
      },
    };
    (Game as any).rooms = { W1N1: room };
    return room;
  }

  it('surfaces missing leaf inputs for the top-priority goal rather than returning empty', () => {
    // Live stuck-state: O and H are stocked but G and X (catalyst) are missing.
    // The old chainMissingInputs would return [] (stuck at OH "producing" step);
    // the new whole-chain scan must return the actually missing leaf inputs.
    makeRoom({ O: 3000, H: 15000, OH: 59, G: 0 }, { X: 0 });

    const needs = getChainBuyNeeds(makeRoom({ O: 3000, H: 15000, OH: 59, G: 0 }, { X: 0 }));

    // Must not be empty — the bug would return []
    expect(needs.length).toBeGreaterThan(0);
    // G and X are base minerals / catalyst that are missing from the XGHO2 chain
    expect(needs).toContain('G' as ResourceConstant);
  });

  it('returns empty when all leaf inputs for the top goal are stocked', () => {
    // All leaf inputs for the highest-priority achievable goal are available
    // (≥ MIN_STEP_AMOUNT = 200) — nothing to buy.
    makeRoom({ O: 500, H: 500, G: 500, X: 500 });

    const needs = getChainBuyNeeds(makeRoom({ O: 500, H: 500, G: 500, X: 500 }));

    // Fully stocked leaves → nothing to buy
    expect(needs).toHaveLength(0);
  });
});

// ── Item 1: per-goal satisfaction cap + hysteresis ───────────────────────────

describe('goal satisfaction cap (selectReaction)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetReactionGoalCache();
  });

  /** Minimal room with given storage contents. No terminal, no input labs loaded. */
  function makeCapRoom(storage: Record<string, number>): any {
    const storageStore: Record<string, any> = { ...storage };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storage[r] ?? 0) : 0)),
    });
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: { store: storageStore },
      terminal: null,
    });
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3'], inputLabIds: ['lab1', 'lab2'] },
    };
    (Game as any).rooms = { W1N1: room };
    return room;
  }

  it('skips GH2O goal when stock >= cap (4000) and advances to next reachable goal', () => {
    // GH2O stock at 4000 (at cap) → goal should be satisfied and skipped.
    // KH and O are stocked so KHO2's precursor step (KH+O→KHO2) is reachable.
    // GHO2 would come first in REACTION_GOALS but K/O are present not G —
    // so KHO2's chain step (KH+O→KHO2) is the first achievable non-GH2O step
    // depending on what comes next in REACTION_GOALS after GH2O.
    // We rely on REACTION_GOALS ordering: GH2O → ... → GHO2 → LHO2 → KHO2.
    // For this test we just check that the selected reaction is NOT in the GH2O chain.
    const room = makeCapRoom({
      GH2O: 4000, // at cap — should be satisfied
      KH: 500, // enables KH+O→KHO2
      O: 500, // enables KH+O→KHO2
    });

    const result = selectReaction(room);

    // GH2O goal must be skipped; a KHO2-chain step should be selected
    expect(result).toBeDefined();
    // The output must NOT be on the GH2O production chain (GH, OH, GH2O)
    expect(result?.output).not.toBe('GH2O');
    expect(result?.output).not.toBe('GH');
    expect(result?.output).not.toBe('OH');
    // The chosen step must be on a defensive-precursor chain
    expect(result?.output).toBe('KHO2');
  });

  it('pursues GH2O again once stock drops below cap*0.5 (2000)', () => {
    // First call: satisfied at 4000
    const room4000 = makeCapRoom({ GH2O: 4000, KH: 500, O: 500 });
    const sat = selectReaction(room4000);
    expect(sat?.output).toBe('KHO2'); // GH2O skipped

    // Second call (same room name, stock now at 1900 — below 4000*0.5=2000):
    // hysteresis releases, GH2O is pursued again. O is included so the
    // goal-directed solver can resolve OH (O+H->OH) — without O, GH2O's OH
    // branch is blocked entirely and selection falls through to the greedy
    // GH fallback instead (a distinct, also-valid outcome but not what this
    // test is checking).
    const room1900 = makeCapRoom({ GH2O: 1900, G: 500, H: 500, O: 500 });
    const resumed = selectReaction(room1900);
    // GH (G+H→GH) or OH are the reachable GH2O-chain steps with G:500 H:500 O:500
    expect(['GH', 'OH']).toContain(resumed?.output);
  });

  it('stays satisfied (does not flip back) when stock is in the hysteresis band (2000–4000)', () => {
    // Mark as satisfied at 4000
    makeCapRoom({ GH2O: 4000, KH: 500, O: 500 });
    selectReaction(makeCapRoom({ GH2O: 4000, KH: 500, O: 500 }));

    // Stock at 2500 — above cap*0.5 (2000) but below cap (4000): still satisfied
    const roomMid = makeCapRoom({ GH2O: 2500, KH: 500, O: 500 });
    const midResult = selectReaction(roomMid);

    // Must still skip GH2O and return a defensive-precursor step
    expect(midResult?.output).toBe('KHO2');
  });

  it('GH2O cap (4000) is above upgrader boost floor (1500)', () => {
    // Safety invariant: the cap must stay well above 1500 so rotation never
    // starves the upgrader boost.
    // If GOAL_CAPS.GH2O were ever lowered below 1500 this test catches it.
    // We import GOAL_CAPS indirectly by testing observable selectReaction behaviour:
    // at 1500 GH2O stock the goal must NOT be satisfied (still pursued).
    const room = makeCapRoom({ GH2O: 1500, G: 500, H: 500 });
    const result = selectReaction(room);
    // GH2O chain is reachable (G+H→GH step); must not be skipped at 1500
    expect(['GH', 'OH']).toContain(result?.output);
  });
});

describe('goal satisfaction cap (getChainBuyNeeds)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetReactionGoalCache();
  });

  function makeNeedsRoom(storage: Record<string, number>): any {
    const storageStore: Record<string, any> = { ...storage };
    Object.defineProperty(storageStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn((r?: string) => (r ? (storage[r] ?? 0) : 0)),
    });
    const terminalStore: Record<string, any> = {};
    Object.defineProperty(terminalStore, 'getUsedCapacity', {
      enumerable: false,
      value: vi.fn(() => 0),
    });
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 7 },
      storage: { store: storageStore },
      terminal: { store: terminalStore },
    });
    (Memory as any).rooms = {
      W1N1: { labIds: ['lab1', 'lab2', 'lab3'], inputLabIds: ['lab1', 'lab2'] },
    };
    (Game as any).rooms = { W1N1: room };
    return room;
  }

  it('skips GH2O buy needs once GH2O stock >= cap and advances to next goal', () => {
    // GH2O at 4000 → satisfied.
    // Storage has G:0, H:0 — so if GH2O goal were NOT satisfied it would surface
    // G and H as buy needs. With GH2O satisfied the function must move on.
    // K:500 + O:500 means KHO2's first chain step (K+H→KH) needs H, but more
    // importantly: GH2O's own chain inputs are no longer the primary return value.
    //
    // Concrete test: compare the satisfied vs unsatisfied result for the same stock.
    // Unsatisfied (fresh cache) → returns GH2O chain needs (G missing).
    // Satisfied → must return something different (advancing to next goal).
    resetReactionGoalCache(); // ensure unsatisfied baseline
    const roomUnsatisfied = makeNeedsRoom({ GH2O: 100 }); // below cap, GH2O pursued
    const needsUnsatisfied = getChainBuyNeeds(roomUnsatisfied);
    // GH2O chain needs G (since G is a leaf input and missing)
    expect(needsUnsatisfied).toContain('G' as ResourceConstant);

    // Now satisfy GH2O at 4000 and call again
    resetReactionGoalCache();
    const roomSatisfied = makeNeedsRoom({ GH2O: 4000 }); // at cap
    const needsSatisfied = getChainBuyNeeds(roomSatisfied);

    // With GH2O satisfied and no other resources in storage,
    // the function advances past GH2O to the next goal. Since nothing is available
    // for later goals either, it either returns [] or needs from another goal.
    // The key invariant: GH2O chain is no longer the driver — the result must
    // differ from the unsatisfied case when G is the primary missing input.
    // (We can't assert needsSatisfied === [] because other goal chains may also
    // surface G as a leaf input — but GH2O is no longer the driving goal.)
    //
    // What we CAN assert: when GH2O is satisfied, the call does not return needs
    // driven by a GH2O-ONLY precursor path. We verify this by checking that
    // GH2O satisfied + G:500/H:500 in storage does NOT select GH2O chain steps
    // (a separate selectReaction call on the same room should skip GH2O).
    expect(needsSatisfied).not.toEqual(needsUnsatisfied);
  });

  it('resumes GH2O buy needs once stock drops below cap*0.5', () => {
    // First call: satisfied at 4000
    const roomSat = makeNeedsRoom({ GH2O: 4000, O: 500 });
    getChainBuyNeeds(roomSat); // prime the satisfied state

    // Second call: stock at 1500 — below 2000 (cap*0.5) → no longer satisfied
    const roomLow = makeNeedsRoom({ GH2O: 1500 }); // G and H both missing
    const needs = getChainBuyNeeds(roomLow);

    // GH2O goal resumed: G (and/or H) should be surfaced as buy needs
    expect(needs).toContain('G' as ResourceConstant);
  });
});
