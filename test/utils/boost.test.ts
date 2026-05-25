import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { ensureBoosted } from '../../src/utils/boost';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

import { moveTo } from '../../src/utils/movement';

// Missing constants used by boost.ts but not yet in screeps.ts mock
(globalThis as any).LAB_BOOST_MINERAL = 30;
(globalThis as any).LAB_BOOST_ENERGY = 20;
(globalThis as any).ERR_NOT_ENOUGH_RESOURCES = -6;

/** Build a minimal mock StructureLab. */
function mockLab(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? ('lab1' as Id<StructureLab>),
    structureType: STRUCTURE_LAB,
    pos: overrides.pos ?? new (globalThis as any).RoomPosition(26, 25, 'W1N1'),
    mineralType: overrides.mineralType ?? null,
    store: overrides.store ?? {
      getUsedCapacity: vi.fn((resource: string) => {
        if (resource === overrides.compound) return overrides.mineralStock ?? 0;
        if (resource === RESOURCE_ENERGY) return overrides.energyStock ?? 0;
        return 0;
      }),
    },
    boostCreep: overrides.boostCreep ?? vi.fn(() => OK),
    isActive: vi.fn(() => true),
    ...overrides,
  };
}

describe('ensureBoosted', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  it('returns true immediately when no boosts field is set', () => {
    const creep = mockCreep({ memory: { role: 'upgrader' } });
    expect(ensureBoosted(creep)).toBe(true);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('returns true immediately when boosts array is empty', () => {
    const creep = mockCreep({ memory: { role: 'upgrader', boosts: [] } });
    expect(ensureBoosted(creep)).toBe(true);
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('skips an entry where all parts are already boosted and returns true', () => {
    // creep has one WORK part that is already boosted
    const creep = mockCreep({
      body: [{ type: WORK, hits: 100, boost: 'UH' }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
    });
    // No lab needed — the entry should be consumed because partCount === 0
    const room = mockRoom({ find: vi.fn(() => []) });
    creep.room = room;

    expect(ensureBoosted(creep)).toBe(true);
    expect(creep.memory.boosts).toBeUndefined();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('returns false and calls moveTo when lab found but creep is out of range', () => {
    // creep at (25,25); lab at (30,25) — range 5, outside range 1
    const labPos = new (globalThis as any).RoomPosition(30, 25, 'W1N1');
    const lab = mockLab({
      id: 'lab1',
      compound: 'UH',
      mineralType: 'UH',
      mineralStock: 300,
      energyStock: 200,
      pos: labPos,
      store: {
        getUsedCapacity: vi.fn((r: string) => {
          if (r === 'UH') return 300;
          if (r === RESOURCE_ENERGY) return 200;
          return 0;
        }),
      },
    });

    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [{ type: WORK, hits: 100, boost: undefined }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
      room: mockRoom({
        find: vi.fn(() => [lab]),
      }),
    });

    const result = ensureBoosted(creep);

    expect(result).toBe(false);
    expect(moveTo).toHaveBeenCalledWith(creep, lab, { range: 1, priority: expect.any(Number) });
    expect(lab.boostCreep).not.toHaveBeenCalled();
  });

  it('calls boostCreep, removes the entry, and returns true when single boost succeeds', () => {
    // creep is adjacent to the lab (range 1)
    const labPos = new (globalThis as any).RoomPosition(26, 25, 'W1N1');
    const lab = mockLab({
      compound: 'UH',
      mineralType: 'UH',
      pos: labPos,
      store: {
        getUsedCapacity: vi.fn((r: string) => {
          if (r === 'UH') return 300;
          if (r === RESOURCE_ENERGY) return 200;
          return 0;
        }),
      },
      boostCreep: vi.fn(() => OK),
    });

    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [{ type: WORK, hits: 100, boost: undefined }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
      room: mockRoom({ find: vi.fn(() => [lab]) }),
    });

    const result = ensureBoosted(creep);

    expect(result).toBe(true);
    expect(lab.boostCreep).toHaveBeenCalledWith(creep);
    expect(creep.memory.boosts).toBeUndefined();
  });

  it('returns false after first boost OK when a second boost is still pending', () => {
    const labPos = new (globalThis as any).RoomPosition(26, 25, 'W1N1');

    const makeStockedStore = (compound: string) => ({
      getUsedCapacity: vi.fn((r: string) => {
        if (r === compound) return 300;
        if (r === RESOURCE_ENERGY) return 200;
        return 0;
      }),
    });

    const lab1 = mockLab({
      id: 'lab1',
      compound: 'UH',
      mineralType: 'UH',
      pos: labPos,
      store: makeStockedStore('UH'),
      boostCreep: vi.fn(() => OK),
    });

    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [
        { type: WORK, hits: 100, boost: undefined },
        { type: MOVE, hits: 100, boost: undefined },
      ],
      memory: {
        role: 'upgrader',
        boosts: [
          { part: WORK, compound: 'UH' },
          { part: MOVE, compound: 'XZHO2' },
        ],
      },
      room: mockRoom({ find: vi.fn(() => [lab1]) }),
    });

    // First call: first boost applied, second still pending → false
    const result1 = ensureBoosted(creep);
    expect(result1).toBe(false);
    expect(lab1.boostCreep).toHaveBeenCalledTimes(1);
    expect(creep.memory.boosts).toHaveLength(1);
    expect(creep.memory.boosts![0]!.part).toBe(MOVE);

    // Second call: second boost — lab not found for XZHO2 → fail-open → true
    const result2 = ensureBoosted(creep);
    expect(result2).toBe(true);
    expect(creep.memory.boosts).toBeUndefined();
  });

  it('waits (returns false) when boostLabId is reserved but lab is understocked', () => {
    const labId = 'reserved_lab' as Id<StructureLab>;
    const labPos = new (globalThis as any).RoomPosition(26, 25, 'W1N1');

    // Lab is reserved but has 0 mineral stock (hauler on the way)
    const reservedLab = mockLab({
      id: labId,
      compound: 'UH',
      mineralType: 'UH',
      pos: labPos,
      store: {
        getUsedCapacity: vi.fn(() => 0), // understocked
      },
      boostCreep: vi.fn(() => ERR_NOT_ENOUGH_RESOURCES),
    });

    Game.getObjectById = vi.fn((id: string) => (id === labId ? reservedLab : undefined)) as any;

    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [{ type: WORK, hits: 100, boost: undefined }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
      room: mockRoom({ name: 'W1N1', find: vi.fn(() => []) }),
    });

    Memory.rooms['W1N1'] = { boostLabId: labId } as any;

    // Lab is in range so boostCreep will be called, returns ERR_NOT_ENOUGH_RESOURCES
    const result = ensureBoosted(creep);

    expect(result).toBe(false);
    // Must NOT have deleted boosts — we are waiting, not failing open
    expect(creep.memory.boosts).toBeDefined();
    expect(creep.memory.boosts).toHaveLength(1);
  });

  it('fails open when no boostLabId and no stocked lab exists', () => {
    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [{ type: WORK, hits: 100, boost: undefined }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
      room: mockRoom({ find: vi.fn(() => []) }),
    });

    const result = ensureBoosted(creep);

    expect(result).toBe(true);
    expect(creep.memory.boosts).toBeUndefined();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('fails open when boostCreep returns an unexpected error code', () => {
    const ERR_BUSY = -4; // arbitrary unexpected code
    const labPos = new (globalThis as any).RoomPosition(26, 25, 'W1N1');

    const lab = mockLab({
      compound: 'UH',
      mineralType: 'UH',
      pos: labPos,
      store: {
        getUsedCapacity: vi.fn((r: string) => {
          if (r === 'UH') return 300;
          if (r === RESOURCE_ENERGY) return 200;
          return 0;
        }),
      },
      boostCreep: vi.fn(() => ERR_BUSY),
    });

    const creep = mockCreep({
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N1'),
      body: [{ type: WORK, hits: 100, boost: undefined }],
      memory: {
        role: 'upgrader',
        boosts: [{ part: WORK, compound: 'UH' }],
      },
      room: mockRoom({ find: vi.fn(() => [lab]) }),
    });

    const result = ensureBoosted(creep);

    expect(result).toBe(true);
    expect(lab.boostCreep).toHaveBeenCalledWith(creep);
    expect(creep.memory.boosts).toBeUndefined();
  });
});
