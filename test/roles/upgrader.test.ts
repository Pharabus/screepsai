import { mockCreep, mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { upgrader } from '../../src/roles/upgrader';

vi.mock('../../src/utils/movement', () => ({ moveTo: vi.fn() }));
vi.mock('../../src/utils/trafficManager', () => ({ PRIORITY_WORKER: 30 }));
vi.mock('../../src/utils/sources', () => ({
  harvestFromBestSource: vi.fn(),
  STORAGE_ENERGY_FLOOR: 10_000,
}));

import { harvestFromBestSource } from '../../src/utils/sources';

function makeStore(energy: number, capacity = 300): any {
  return {
    getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY || !r ? energy : 0),
    getFreeCapacity: (r?: string) => (r === RESOURCE_ENERGY || !r ? capacity - energy : 0),
    getCapacity: () => capacity,
  };
}

function makeLink(energy: number): any {
  return {
    id: 'link1',
    store: {
      getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? energy : 0),
    },
  };
}

function makeContainer(energy: number): any {
  return {
    id: 'container1',
    store: {
      getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? energy : 0),
    },
  };
}

function makeStorage(energy: number): any {
  return {
    id: 'storage1',
    store: {
      getUsedCapacity: (r?: string) => (r === RESOURCE_ENERGY ? energy : 0),
    },
  };
}

describe('upgrader role', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    vi.clearAllMocks();
  });

  describe('GATHER state — priority chain in miner economy', () => {
    function makeCreep(overrides: Record<string, any> = {}): any {
      const room = mockRoom({ name: 'W1N1' });
      room.controller = { my: true, level: 5, pos: new RoomPosition(30, 30, 'W1N1') };
      return mockCreep({
        room,
        memory: { role: 'upgrader', state: 'GATHER' },
        store: makeStore(0), // empty — will look for energy
        ...overrides,
      });
    }

    it('withdraws from controller link when available (highest priority)', () => {
      const link = makeLink(400);
      const container = makeContainer(1000);
      const storage = makeStorage(50_000);

      const creep = makeCreep();
      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'ctrlLink') return link;
        if (id === 'ctrlContainer') return container;
        if (id === 'storage1') return storage;
        return null;
      });
      Memory.rooms['W1N1'] = {
        minerEconomy: true,
        controllerLinkId: 'ctrlLink',
        controllerContainerId: 'ctrlContainer',
      };
      creep.room.storage = storage;

      upgrader.run(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
    });

    it('falls back to controller container when link is empty', () => {
      const link = makeLink(0); // empty
      const container = makeContainer(500);
      const storage = makeStorage(50_000);

      const creep = makeCreep();
      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'ctrlLink') return link;
        if (id === 'ctrlContainer') return container;
        if (id === 'storage1') return storage;
        return null;
      });
      Memory.rooms['W1N1'] = {
        minerEconomy: true,
        controllerLinkId: 'ctrlLink',
        controllerContainerId: 'ctrlContainer',
      };
      creep.room.storage = storage;

      upgrader.run(creep);

      expect(creep.withdraw).not.toHaveBeenCalledWith(link, RESOURCE_ENERGY);
      expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    });

    it('falls back to storage when link and container are empty', () => {
      const link = makeLink(0);
      const container = makeContainer(0);
      const storage = makeStorage(50_000);

      const creep = makeCreep();
      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'ctrlLink') return link;
        if (id === 'ctrlContainer') return container;
        if (id === 'storage1') return storage;
        return null;
      });
      Memory.rooms['W1N1'] = {
        minerEconomy: true,
        controllerLinkId: 'ctrlLink',
        controllerContainerId: 'ctrlContainer',
      };
      creep.room.storage = storage;

      upgrader.run(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    });

    it('self-harvests when storage is below STORAGE_ENERGY_FLOOR', () => {
      const link = makeLink(0);
      const container = makeContainer(0);
      const storage = makeStorage(5_000); // below 10k floor

      const creep = makeCreep();
      Game.getObjectById = vi.fn((id: string) => {
        if (id === 'ctrlLink') return link;
        if (id === 'ctrlContainer') return container;
        if (id === 'storage1') return storage;
        return null;
      });
      Memory.rooms['W1N1'] = {
        minerEconomy: true,
        controllerLinkId: 'ctrlLink',
        controllerContainerId: 'ctrlContainer',
      };
      creep.room.storage = storage;

      upgrader.run(creep);

      expect(creep.withdraw).not.toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
      expect(harvestFromBestSource).toHaveBeenCalled();
    });

    it('self-harvests in bootstrap economy (no miner economy)', () => {
      const creep = makeCreep();
      Memory.rooms['W1N1'] = { minerEconomy: false };

      upgrader.run(creep);

      expect(harvestFromBestSource).toHaveBeenCalled();
    });
  });

  describe('WORK state', () => {
    it('upgrades controller when it has energy', () => {
      const controller = {
        my: true,
        level: 5,
        pos: new RoomPosition(30, 30, 'W1N1'),
      };
      const room = mockRoom({ name: 'W1N1' });
      room.controller = controller;

      const creep = mockCreep({
        room,
        memory: { role: 'upgrader', state: 'WORK' },
        store: makeStore(100), // has energy
      });
      Memory.rooms['W1N1'] = { minerEconomy: true };

      upgrader.run(creep);

      expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    });

    it('transitions back to GATHER when energy is empty', () => {
      const room = mockRoom({ name: 'W1N1' });
      room.controller = { my: true, level: 5, pos: new RoomPosition(30, 30, 'W1N1') };

      const creep = mockCreep({
        room,
        memory: { role: 'upgrader', state: 'WORK' },
        store: makeStore(0), // empty
      });
      Memory.rooms['W1N1'] = { minerEconomy: true };

      upgrader.run(creep);

      expect(creep.memory.state).toBe('GATHER');
      expect(creep.upgradeController).not.toHaveBeenCalled();
    });
  });
});
