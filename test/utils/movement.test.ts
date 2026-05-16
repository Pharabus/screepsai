import { mockCreep, resetGameGlobals } from '../mocks/screeps';

vi.mock('../../src/utils/trafficManager', () => ({
  executeMove: vi.fn(),
  executeMoveAvoidCreeps: vi.fn(),
}));

import { moveTo, cleanStuckTracker } from '../../src/utils/movement';
import { executeMove, executeMoveAvoidCreeps } from '../../src/utils/trafficManager';

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

  it('falls back to native moveTo after 3 stuck ticks', () => {
    const creep = mockCreep({ name: 'c1', pos: new RoomPosition(10, 10, 'W1N1') });

    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // baseline
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 1
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 2 (repath)
    moveTo(creep, new RoomPosition(20, 20, 'W1N1')); // count = 3 (native)

    expect(creep.moveTo).toHaveBeenCalledTimes(1);
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
});
