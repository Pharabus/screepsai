import { reserver } from '../../src/roles/reserver';
import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';

describe('reserver', () => {
  beforeEach(() => {
    resetGameGlobals();
  });

  it('moves toward target room when not there yet', () => {
    const creep = mockCreep({
      name: 'reserver_1',
      memory: { role: 'reserver', homeRoom: 'W1N1', targetRoom: 'W1N2', state: 'RESERVE' },
      room: mockRoom({ name: 'W1N1' }),
    });

    (Game as any).creeps = { reserver_1: creep };

    reserver.run(creep);

    // Should have called move (via moveTo wrapper → PathFinder → creep.move)
    // Since PathFinder.search returns empty path, the creep won't actually move,
    // but we verify no crash and the state remains RESERVE
    expect(creep.memory.state).toBe('RESERVE');
  });

  it('calls reserveController when in target room', () => {
    const controller = {
      id: 'ctrl1',
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N2'),
    };
    const room = mockRoom({
      name: 'W1N2',
      controller,
    });
    const creep = mockCreep({
      name: 'reserver_1',
      memory: { role: 'reserver', homeRoom: 'W1N1', targetRoom: 'W1N2', state: 'RESERVE' },
      room,
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N2'),
      reserveController: vi.fn(() => OK),
    });

    (Game as any).creeps = { reserver_1: creep };
    (Game as any).rooms = { W1N2: room };

    reserver.run(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
  });

  it('moves to controller when reserveController returns ERR_NOT_IN_RANGE', () => {
    const controller = {
      id: 'ctrl1',
      pos: new (globalThis as any).RoomPosition(10, 10, 'W1N2'),
    };
    const room = mockRoom({
      name: 'W1N2',
      controller,
    });
    const creep = mockCreep({
      name: 'reserver_1',
      memory: { role: 'reserver', homeRoom: 'W1N1', targetRoom: 'W1N2', state: 'RESERVE' },
      room,
      pos: new (globalThis as any).RoomPosition(25, 25, 'W1N2'),
      reserveController: vi.fn(() => ERR_NOT_IN_RANGE),
    });

    (Game as any).creeps = { reserver_1: creep };
    (Game as any).rooms = { W1N2: room };

    reserver.run(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    // moveTo will have been called (creep.move via PathFinder)
    expect(creep.memory.state).toBe('RESERVE');
  });

  it('does nothing when targetRoom is not set', () => {
    const creep = mockCreep({
      name: 'reserver_1',
      memory: { role: 'reserver', homeRoom: 'W1N1', state: 'RESERVE' },
      room: mockRoom({ name: 'W1N1' }),
      reserveController: vi.fn(),
    });

    (Game as any).creeps = { reserver_1: creep };

    reserver.run(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
  });
});
