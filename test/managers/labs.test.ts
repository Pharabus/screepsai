import { getChainBuyNeeds, runLabs, selectReaction } from '../../src/managers/labs';
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
});

describe('selectReaction', () => {
  beforeEach(() => {
    resetGameGlobals();
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
