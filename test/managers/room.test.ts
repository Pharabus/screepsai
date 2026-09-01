import { mockCreep, resetGameGlobals } from '../mocks/screeps';

const { mockHarvesterRun } = vi.hoisted(() => ({ mockHarvesterRun: vi.fn() }));

vi.mock('../../src/roles', () => ({
  roles: {
    harvester: { run: mockHarvesterRun },
  },
}));

import { runRooms } from '../../src/managers/room';
import * as trafficManager from '../../src/utils/trafficManager';

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

  it('marks every creep dispatched before role.run, regardless of spawning/throttle state', () => {
    // pushBlocker's mutual-cancellation fix (trafficManager.ts) trusts that
    // EVERY creep in this loop gets markDispatched() called before its own
    // movement logic could possibly run — including the spawning creep,
    // which never reaches role.run() at all. Verifying this holds here means
    // the guarantee pushBlocker relies on isn't silently broken by a future
    // edit to this loop's branch structure.
    const spy = vi.spyOn(trafficManager, 'markDispatched');
    const spawningCreep = mockCreep({
      name: 'harvester_spawning2',
      spawning: true,
      memory: { role: 'harvester' },
    });
    const readyCreep = mockCreep({
      name: 'harvester_ready2',
      spawning: false,
      memory: { role: 'harvester', homeRoom: 'W1N1' },
    });
    (Game as any).creeps = {
      [spawningCreep.name]: spawningCreep,
      [readyCreep.name]: readyCreep,
    };
    (Memory as any).creeps = {
      [spawningCreep.name]: spawningCreep.memory,
      [readyCreep.name]: readyCreep.memory,
    };

    runRooms();

    expect(spy).toHaveBeenCalledWith(spawningCreep);
    expect(spy).toHaveBeenCalledWith(readyCreep);
    spy.mockRestore();
  });
});
