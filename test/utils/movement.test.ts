import { mockCreep, resetGameGlobals } from '../mocks/screeps';

vi.mock('../../src/utils/trafficManager', () => ({
  executeMove: vi.fn(),
  executeMoveAvoidCreeps: vi.fn(),
  executeMoveHardAvoidCreeps: vi.fn(() => false),
  invalidateSerialPath: vi.fn(),
  mdbg: vi.fn(),
}));

import { moveTo, cleanStuckTracker, isInRoomInterior } from '../../src/utils/movement';
import {
  executeMove,
  executeMoveAvoidCreeps,
  executeMoveHardAvoidCreeps,
} from '../../src/utils/trafficManager';

describe('isInRoomInterior', () => {
  it('returns false on border tiles', () => {
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(0, 25, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(49, 25, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(25, 0, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(25, 49, 'W1N1') }))).toBe(false);
  });

  it('returns false within the 2-tile border ring', () => {
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(2, 25, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(47, 25, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(25, 2, 'W1N1') }))).toBe(false);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(25, 47, 'W1N1') }))).toBe(false);
  });

  it('returns true 3+ tiles from any border', () => {
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(3, 25, 'W1N1') }))).toBe(true);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(46, 46, 'W1N1') }))).toBe(true);
    expect(isInRoomInterior(mockCreep({ pos: new RoomPosition(25, 25, 'W1N1') }))).toBe(true);
  });
});

describe('movement stuck handling', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
    // Clear the module-level stuckTicks map by simulating no live creeps.
    Game.creeps = {};
    cleanStuckTracker();
  });

  it('uses the cached path on first call', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });
    moveTo(creep, new RoomPosition(20, 20, 'W1N1'));
    expect(executeMove).toHaveBeenCalledTimes(1);
    expect(executeMoveAvoidCreeps).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('repaths with elevated creep cost after 2 stuck ticks', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });

    // Tick 1: initial — sets baseline position
    moveTo(creep, new RoomPosition(20, 20, 'W1N1'));
    // Tick 2: same position — count becomes 1
    moveTo(creep, new RoomPosition(20, 20, 'W1N1'));
    // Tick 3: still same — count becomes 2 → repath
    moveTo(creep, new RoomPosition(20, 20, 'W1N1'));

    expect(executeMoveAvoidCreeps).toHaveBeenCalledTimes(1);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('forces a fresh repath (not native moveTo) after 3 stuck ticks', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });

    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // baseline
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 1
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 2 → repath
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 3 → forced repath

    expect(executeMoveAvoidCreeps).toHaveBeenCalledTimes(2);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('resets the stuck counter once the creep moves', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });

    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // baseline at (10,10)
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 1

    // Creep moved — should reset count to 0
    creep.pos = new RoomPosition(11, 10, 'W1N1');
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // new baseline at (11,10)
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 1 again
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 2 → repath

    // Repath fires for the first time only at the second 2-tick stuck streak
    expect(executeMoveAvoidCreeps).toHaveBeenCalledTimes(1);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('accepts a target with a pos field', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });
    moveTo(creep, { pos: new RoomPosition(20, 20, 'W1N1') });
    expect(executeMove).toHaveBeenCalled();
  });

  // Regression (2026-09-07): soft avoidance cost caps at 200 and never
  // escalates further, so a creep genuinely wedged in a crowded cluster (every
  // alternate route also crosses another creep) can stay stuck through
  // dozens of repath cycles with zero progress. From cycle 5 onward a
  // hard-block pass should run first.
  it('escalates to a hard-avoid pass once stuck through 5 full cycles', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });
    const target = new RoomPosition(20, 20, 'W1N1');
    (executeMoveHardAvoidCreeps as any).mockReturnValue(true);

    // 3 ticks per force cycle (baseline + 2 stuck ticks); 5 full cycles plus
    // the initial ramp-up reaches cycle 5 on the 16th call.
    for (let i = 0; i < 16; i++) {
      moveTo(creep, target);
    }

    expect(executeMoveHardAvoidCreeps).toHaveBeenCalledTimes(1);
    expect(executeMoveHardAvoidCreeps).toHaveBeenCalledWith(creep, target, 1, undefined);
  });

  it('falls back to soft avoidance when the hard-avoid pass finds no detour', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });
    const target = new RoomPosition(20, 20, 'W1N1');
    (executeMoveHardAvoidCreeps as any).mockReturnValue(false);

    for (let i = 0; i < 16; i++) {
      moveTo(creep, target);
    }

    expect(executeMoveHardAvoidCreeps).toHaveBeenCalledTimes(1);
    expect(executeMoveAvoidCreeps).toHaveBeenLastCalledWith(creep, target, 1, undefined, 200);
  });

  it('does not attempt hard-avoid before cycle 5', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });
    const target = new RoomPosition(20, 20, 'W1N1');

    // 4 calls reaches cycle 1 only (see the existing "forces a fresh repath"
    // test above) — well short of the cycle-5 escalation threshold.
    for (let i = 0; i < 4; i++) {
      moveTo(creep, target);
    }

    expect(executeMoveHardAvoidCreeps).not.toHaveBeenCalled();
  });
});
