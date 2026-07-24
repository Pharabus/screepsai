import { runPowerSpawn } from '../../src/managers/power';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
});

function makePowerSpawn(power: number, energy: number): any {
  return {
    id: 'powerSpawn1' as Id<StructurePowerSpawn>,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === RESOURCE_POWER) return power;
        if (resource === RESOURCE_ENERGY) return energy;
        return 0;
      },
    },
    processPower: vi.fn(() => OK),
  };
}

function setupRoom(opts: {
  rcl: number;
  power: number;
  energy: number;
  powerSpawnId?: string;
}): Room {
  const powerSpawn = makePowerSpawn(opts.power, opts.energy);

  (Game as any).rooms = {};
  (Memory as any).rooms = {};

  const room = mockRoom({
    name: 'W1N1',
    controller: {
      my: true,
      level: opts.rcl,
      pos: new (globalThis as any).RoomPosition(30, 30, 'W1N1'),
    },
    find: vi.fn(() => []),
  });

  (Game as any).rooms['W1N1'] = room;
  (Memory as any).rooms['W1N1'] = {
    powerSpawnId: opts.powerSpawnId ?? powerSpawn.id,
  };

  (Game as any).getObjectById = vi.fn((id: string) => {
    if (id === powerSpawn.id) return powerSpawn;
    return null;
  });

  (room as any)._powerSpawn = powerSpawn;
  return room;
}

describe('runPowerSpawn', () => {
  it('calls processPower when power >= 1 and energy >= POWER_SPAWN_ENERGY_RATIO', () => {
    const room = setupRoom({ rcl: 8, power: 5, energy: 100 });
    runPowerSpawn();
    const powerSpawn = (room as any)._powerSpawn;
    expect(powerSpawn.processPower).toHaveBeenCalled();
  });

  it('skips when power is 0', () => {
    const room = setupRoom({ rcl: 8, power: 0, energy: 5000 });
    runPowerSpawn();
    const powerSpawn = (room as any)._powerSpawn;
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });

  it('skips when energy is below POWER_SPAWN_ENERGY_RATIO', () => {
    const room = setupRoom({ rcl: 8, power: 5, energy: 10 });
    runPowerSpawn();
    const powerSpawn = (room as any)._powerSpawn;
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });

  it('does not run for rooms below RCL 8', () => {
    const room = setupRoom({ rcl: 7, power: 5, energy: 5000 });
    runPowerSpawn();
    const powerSpawn = (room as any)._powerSpawn;
    expect(powerSpawn.processPower).not.toHaveBeenCalled();
  });

  it('does nothing when the room has no power spawn recorded', () => {
    (Game as any).rooms = {};
    (Memory as any).rooms = {};
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 8, pos: new (globalThis as any).RoomPosition(30, 30, 'W1N1') },
      find: vi.fn(() => []),
    });
    (Game as any).rooms['W1N1'] = room;
    (Memory as any).rooms['W1N1'] = {};

    expect(() => runPowerSpawn()).not.toThrow();
  });

  it('skips unowned rooms entirely', () => {
    (Game as any).rooms = {};
    (Memory as any).rooms = {};
    const room = mockRoom({
      name: 'W9N9',
      controller: { my: false, level: 8 },
      find: vi.fn(() => []),
    });
    (Game as any).rooms['W9N9'] = room;

    expect(() => runPowerSpawn()).not.toThrow();
  });
});
