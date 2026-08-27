import { mockCreep, resetGameGlobals } from '../mocks/screeps';

const { mockHarvesterRun } = vi.hoisted(() => ({ mockHarvesterRun: vi.fn() }));

vi.mock('../../src/roles', () => ({
  roles: {
    harvester: { run: mockHarvesterRun },
  },
}));

import { runRooms } from '../../src/managers/room';

beforeEach(() => {
  resetGameGlobals();
  mockHarvesterRun.mockClear();
  (Game as any).creeps = {};
  (Memory as any).creeps = {};
});

describe('runRooms — spawning guard', () => {
  it('skips role dispatch entirely for a creep still spawning', () => {
    const creep = mockCreep({
      name: 'harvester_spawning',
      spawning: true,
      memory: { role: 'harvester' },
    });
    (Game as any).creeps = { [creep.name]: creep };
    (Memory as any).creeps = { [creep.name]: creep.memory };

    runRooms();

    expect(mockHarvesterRun).not.toHaveBeenCalled();
  });

  it('dispatches role.run normally once a creep has finished spawning', () => {
    const creep = mockCreep({
      name: 'harvester_ready',
      spawning: false,
      memory: { role: 'harvester', homeRoom: 'W1N1' },
    });
    (Game as any).creeps = { [creep.name]: creep };
    (Memory as any).creeps = { [creep.name]: creep.memory };

    runRooms();

    expect(mockHarvesterRun).toHaveBeenCalledTimes(1);
    expect(mockHarvesterRun).toHaveBeenCalledWith(creep);
  });

  it('treats undefined spawning (legacy/mocked creeps) as not spawning', () => {
    const creep = mockCreep({
      name: 'harvester_legacy',
      memory: { role: 'harvester', homeRoom: 'W1N1' },
    });
    delete creep.spawning;
    (Game as any).creeps = { [creep.name]: creep };
    (Memory as any).creeps = { [creep.name]: creep.memory };

    runRooms();

    expect(mockHarvesterRun).toHaveBeenCalledTimes(1);
  });
});
