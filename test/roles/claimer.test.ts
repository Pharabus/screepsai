import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

import { claimer } from '../../src/roles/claimer';
import { moveTo } from '../../src/utils/movement';

describe('claimer', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  it('returns to TRAVEL if state is CLAIM but creep is not in target room', () => {
    // Regression: claimer_80174499 claimed W44N58 instead of W44N57 because
    // the CLAIM state used creep.room.controller without checking the room.
    const wrongRoomController = {
      pos: { x: 25, y: 14 },
      my: false,
    };
    const wrongRoom = mockRoom({ name: 'W44N58', controller: wrongRoomController });
    const creep = mockCreep({
      name: 'bad_claimer',
      room: wrongRoom,
      pos: new RoomPosition(26, 14, 'W44N58'),
      memory: { role: 'claimer', state: 'CLAIM', targetRoom: 'W44N57' },
    });
    (creep as any).claimController = vi.fn(() => 0);

    claimer.run(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    // After state revert, the TRAVEL handler runs — it calls moveTo toward target room
    expect(creep.memory.state).toBe('TRAVEL');
  });

  it('claims the controller when in the target room', () => {
    const controller = {
      pos: { x: 18, y: 13 },
      my: false,
    };
    const targetRoom = mockRoom({ name: 'W44N57', controller });
    const creep = mockCreep({
      name: 'good_claimer',
      room: targetRoom,
      pos: new RoomPosition(18, 13, 'W44N57'),
      memory: { role: 'claimer', state: 'CLAIM', targetRoom: 'W44N57' },
    });
    (creep as any).claimController = vi.fn(() => 0);

    claimer.run(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
  });

  it('transitions TRAVEL → CLAIM when arriving in the target room', () => {
    const controller = { pos: { x: 18, y: 13 }, my: false };
    const targetRoom = mockRoom({ name: 'W44N57', controller });
    const creep = mockCreep({
      name: 'arriving_claimer',
      room: targetRoom,
      pos: new RoomPosition(25, 25, 'W44N57'),
      memory: { role: 'claimer', state: 'TRAVEL', targetRoom: 'W44N57' },
    });
    (creep as any).claimController = vi.fn(() => -9); // ERR_NOT_IN_RANGE

    claimer.run(creep);

    expect(creep.memory.state).toBe('CLAIM');
  });

  it('paths toward target room when not yet arrived', () => {
    const transitRoom = mockRoom({ name: 'W43N58', controller: undefined });
    const creep = mockCreep({
      name: 'traveling_claimer',
      room: transitRoom,
      pos: new RoomPosition(25, 25, 'W43N58'),
      memory: { role: 'claimer', state: 'TRAVEL', targetRoom: 'W44N57' },
    });

    claimer.run(creep);

    expect(moveTo).toHaveBeenCalledWith(
      creep,
      expect.objectContaining({ roomName: 'W44N57' }),
      expect.any(Object),
    );
  });
});
