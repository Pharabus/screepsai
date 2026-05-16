import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { runDefense, defendersNeeded } from '../../src/managers/defense';

vi.mock('../../src/utils/neighbors', () => ({
  recordHostile: vi.fn(),
  requestNeighborSegment: vi.fn(),
}));

vi.mock('../../src/utils/threat', () => ({
  threatScore: vi.fn((creep: any) => creep._threatScore ?? 0),
}));

function makeHostile(opts: { threatScore?: number; owner?: string } = {}): any {
  return mockCreep({
    owner: { username: opts.owner ?? 'Enemy' },
    _threatScore: opts.threatScore ?? 80,
    body: [{ type: 'attack', hits: 100 }],
  });
}

describe('defendersNeeded', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('returns 0 when no threat has ever been seen', () => {
    const room = mockRoom({ name: 'W1N1' });
    Memory.rooms['W1N1'] = {};
    expect(defendersNeeded(room)).toBe(0);
  });

  it('returns 0 when threat was seen but outside the memory window', () => {
    const room = mockRoom({ name: 'W1N1' });
    Game.time = 1000;
    Memory.rooms['W1N1'] = {
      threatLastSeen: 900, // 100 ticks ago, window is 50
      lastThreatScore: 80,
    };
    expect(defendersNeeded(room)).toBe(0);
  });

  it('returns >0 within the threat memory window', () => {
    const room = mockRoom({ name: 'W1N1' });
    Game.time = 1000;
    Memory.rooms['W1N1'] = {
      threatLastSeen: 980, // 20 ticks ago, within 50-tick window
      lastThreatScore: 80,
    };
    expect(defendersNeeded(room)).toBeGreaterThan(0);
  });

  it('returns 0 when lastThreatScore is 0', () => {
    const room = mockRoom({ name: 'W1N1' });
    Game.time = 1000;
    Memory.rooms['W1N1'] = {
      threatLastSeen: 990,
      lastThreatScore: 0,
    };
    expect(defendersNeeded(room)).toBe(0);
  });

  it('scales defender count with threat score', () => {
    const room = mockRoom({ name: 'W1N1' });
    Game.time = 1000;

    Memory.rooms['W1N1'] = { threatLastSeen: 999, lastThreatScore: 200 };
    const one = defendersNeeded(room);

    Memory.rooms['W1N1'] = { threatLastSeen: 999, lastThreatScore: 600 };
    const three = defendersNeeded(room);

    expect(three).toBeGreaterThan(one);
  });

  it('caps defenders at 4', () => {
    const room = mockRoom({ name: 'W1N1' });
    Game.time = 1000;
    Memory.rooms['W1N1'] = {
      threatLastSeen: 999,
      lastThreatScore: 10_000, // very high threat
    };
    expect(defendersNeeded(room)).toBe(4);
  });
});

describe('runDefense — safe mode guard', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('does not activate safe mode for zero-threat hostiles (scouts)', () => {
    const room = mockRoom({ name: 'W1N1' });
    const spawn = { pos: new RoomPosition(25, 25, 'W1N1') };
    const controller = {
      my: true,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: 0,
      pos: new RoomPosition(30, 30, 'W1N1'),
      activateSafeMode: vi.fn(() => 0),
    };
    room.controller = controller;
    // Implement filter support — hostileNearCriticalStructure uses find with filter
    const zeroThreatHostile = makeHostile({ threatScore: 0 });
    zeroThreatHostile.pos = new RoomPosition(25, 25, 'W1N1');
    room.find = vi.fn((type: number, opts?: { filter?: (c: any) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        const hostiles = [zeroThreatHostile];
        return opts?.filter ? hostiles.filter(opts.filter) : hostiles;
      }
      if (type === FIND_MY_SPAWNS) return [spawn];
      return [];
    }) as any;
    room.storage = undefined;
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {};

    runDefense();
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });

  it('activates safe mode when a threatening hostile is within range 5 of spawn', () => {
    const room = mockRoom({ name: 'W1N1' });
    // hostile at (25,25), spawn at (27,25) — range 2
    const hostile = makeHostile({ threatScore: 100 });
    hostile.pos = new RoomPosition(25, 25, 'W1N1');
    const spawnPos = new RoomPosition(27, 25, 'W1N1');
    const spawn = { pos: spawnPos };
    const controller = {
      my: true,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: 0,
      pos: new RoomPosition(30, 30, 'W1N1'),
      activateSafeMode: vi.fn(() => 0 /* OK */),
    };
    room.controller = controller;
    room.storage = undefined;
    room.find = vi.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_MY_SPAWNS) return [spawn];
      return [];
    }) as any;
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {};

    runDefense();
    expect(controller.activateSafeMode).toHaveBeenCalled();
  });

  it('does not activate safe mode when hostile is far from all critical structures', () => {
    const room = mockRoom({ name: 'W1N1' });
    // hostile at (5,5), spawn at (40,40) — far apart
    const hostile = makeHostile({ threatScore: 100 });
    hostile.pos = new RoomPosition(5, 5, 'W1N1');
    const spawn = { pos: new RoomPosition(40, 40, 'W1N1') };
    const controller = {
      my: true,
      safeMode: undefined,
      safeModeAvailable: 1,
      safeModeCooldown: 0,
      pos: new RoomPosition(40, 40, 'W1N1'),
      activateSafeMode: vi.fn(() => 0),
    };
    room.controller = controller;
    room.storage = undefined;
    room.find = vi.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_MY_SPAWNS) return [spawn];
      return [];
    }) as any;
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {};

    runDefense();
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });

  it('does not activate safe mode when safe mode is already active', () => {
    const room = mockRoom({ name: 'W1N1' });
    const hostile = makeHostile({ threatScore: 100 });
    hostile.pos = new RoomPosition(25, 25, 'W1N1');
    const spawn = { pos: new RoomPosition(27, 25, 'W1N1') };
    const controller = {
      my: true,
      safeMode: 500, // already active
      safeModeAvailable: 1,
      safeModeCooldown: 0,
      pos: new RoomPosition(30, 30, 'W1N1'),
      activateSafeMode: vi.fn(() => 0),
    };
    room.controller = controller;
    room.storage = undefined;
    room.find = vi.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_MY_SPAWNS) return [spawn];
      return [];
    }) as any;
    Game.rooms['W1N1'] = room;
    Memory.rooms['W1N1'] = {};

    runDefense();
    expect(controller.activateSafeMode).not.toHaveBeenCalled();
  });

  it('records NPC Invader presence and clears when room is confirmed clear', () => {
    // First tick: Invader present
    const room = mockRoom({ name: 'W1N1' });
    const invader = makeHostile({ owner: 'Invader', threatScore: 80 });
    room.controller = { my: false }; // non-owned room
    room.find = vi.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [invader];
      return [];
    }) as any;
    Game.rooms['W1N1'] = room;
    Game.time = 1000;
    Memory.rooms['W1N1'] = {};

    runDefense();
    expect(Memory.rooms['W1N1']?.invaderSeenAt).toBe(1000);

    // Second tick: room clear — invaderSeenAt should be removed
    room.find = vi.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) return [];
      return [];
    }) as any;
    runDefense();
    expect(Memory.rooms['W1N1']?.invaderSeenAt).toBeUndefined();
  });
});
