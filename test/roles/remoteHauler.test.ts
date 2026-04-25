import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import { remoteHauler } from '../../src/roles/remoteHauler';

vi.mock('../../src/utils/movement', () => ({
  moveTo: vi.fn(),
}));

vi.mock('../../src/utils/delivery', () => ({
  deliverToSpawnOrExtension: vi.fn(() => false),
  deliverToControllerContainer: vi.fn(() => false),
}));

import { moveTo } from '../../src/utils/movement';

describe('remoteHauler', () => {
  beforeEach(() => {
    resetGameGlobals();
    vi.clearAllMocks();
  });

  it('picks up from container in remote room', () => {
    const container = {
      id: 'c1' as Id<StructureContainer>,
      structureType: STRUCTURE_CONTAINER,
      hits: 200000,
      hitsMax: 250000,
      store: { getUsedCapacity: () => 500 },
    };

    const remoteRoom = mockRoom({
      name: 'W2N1',
      find: vi.fn(() => []),
    });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: remoteRoom,
      pos: new RoomPosition(10, 10, 'W2N1'),
      store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
      withdraw: vi.fn(() => OK),
    });
    creep.pos.findClosestByRange = vi.fn((_type: number, opts?: any) => {
      if (opts?.filter?.(container)) return container;
      return undefined;
    });

    remoteHauler.run(creep);

    expect(creep.withdraw).toHaveBeenCalled();
  });

  it('paths toward remote room when not there yet', () => {
    Memory.rooms['W2N1'] = {
      sources: [{ id: 's1' as Id<Source>, x: 10, y: 20 }],
    } as any;

    const homeRoom = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });

    const creep = mockCreep({
      memory: { role: 'remoteHauler', state: 'PICKUP', targetRoom: 'W2N1', homeRoom: 'W1N1' },
      room: homeRoom,
      pos: new RoomPosition(25, 25, 'W1N1'),
      store: { getFreeCapacity: () => 200, getUsedCapacity: () => 0 },
    });

    remoteHauler.run(creep);

    expect(moveTo).toHaveBeenCalled();
  });
});
