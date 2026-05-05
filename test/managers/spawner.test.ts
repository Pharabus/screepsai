import {
  buildSpawnQueue,
  minersNeeded,
  haulersNeeded,
  upgradersNeeded,
  remoteBuilderNeeded,
} from '../../src/managers/spawner';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';

beforeEach(() => {
  resetGameGlobals();
  resetTickCache();
});

describe('buildSpawnQueue', () => {
  it('returns bootstrap economy roles when no miner economy', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: false } };
    const room = mockRoom({ name: 'W1N1' });

    const queue = buildSpawnQueue(room);
    const roles = queue.map((r) => r.role);

    expect(roles).toContain('harvester');
    expect(roles).toContain('upgrader');
    expect(roles).toContain('builder');
    expect(roles).toContain('repairer');
    expect(roles).not.toContain('miner');
    expect(roles).not.toContain('hauler');
  });

  it('returns miner economy roles when minerEconomy is true', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const roles = queue.map((r) => r.role);

    expect(roles).toContain('hauler');
    expect(roles).toContain('harvester');
    expect(roles).toContain('upgrader');
    expect(roles).toContain('builder');
    expect(roles).toContain('repairer');
  });

  it('requests 0 builders when all sources linked and storage below floor', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          {
            id: 'src1' as any,
            x: 10,
            y: 10,
            containerId: 'cnt1' as any,
            linkId: 'link1' as any,
            minerName: 'miner_1',
          },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5000 : 0) },
      },
    });
    const queue = buildSpawnQueue(room);
    const builderEntry = queue.find((r) => r.role === 'builder');

    expect(builderEntry?.minCount).toBe(0);
  });

  it('requests builders when sources are unlinked even if storage below floor', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5000 : 0) },
      },
    });
    const queue = buildSpawnQueue(room);
    const builderEntry = queue.find((r) => r.role === 'builder');

    expect(builderEntry?.minCount).toBeGreaterThan(0);
  });

  it('requests builders when all sources linked and storage above floor', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          {
            id: 'src1' as any,
            x: 10,
            y: 10,
            containerId: 'cnt1' as any,
            linkId: 'link1' as any,
            minerName: 'miner_1',
          },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 15000 : 0) },
      },
    });
    const queue = buildSpawnQueue(room);
    const builderEntry = queue.find((r) => r.role === 'builder');

    expect(builderEntry?.minCount).toBeGreaterThan(0);
  });

  it('includes miner when source needs one', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
      },
    };
    (Game as any).creeps = {};

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const roles = queue.map((r) => r.role);

    expect(roles).toContain('miner');
  });

  it('bootstrap harvester minCount is 2', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });

    const queue = buildSpawnQueue(room);
    const harvester = queue.find((r) => r.role === 'harvester');

    expect(harvester?.minCount).toBe(2);
  });

  it('miner economy keeps 1 emergency harvester', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const harvester = queue.find((r) => r.role === 'harvester');

    expect(harvester?.minCount).toBe(1);
  });

  it('scout spawns when there is a room to explore', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };
    Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const scout = queue.find((r) => r.role === 'scout');

    expect(scout).toBeDefined();
    expect(scout!.maxRepeats).toBe(1);
  });

  it('scout does not spawn when all rooms are scouted', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
      W2N1: { scoutedAt: Game.time, scoutedSources: 1 },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };
    Game.map.describeExits = () => ({ '1': 'W2N1' }) as any;

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const scout = queue.find((r) => r.role === 'scout');

    expect(scout).toBeUndefined();
  });
});

describe('minersNeeded', () => {
  it('returns 0 when no sources', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(minersNeeded(room)).toBe(0);
  });

  it('returns 0 when source has no container', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10 }] },
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(minersNeeded(room)).toBe(0);
  });

  it('returns 1 when source has container but no miner', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1' });
    expect(minersNeeded(room)).toBe(1);
  });

  it('returns 0 when miner is alive and assigned', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };
    const room = mockRoom({ name: 'W1N1' });
    expect(minersNeeded(room)).toBe(0);
  });

  it('returns 1 when assigned miner is dead', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_dead' },
        ],
      },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1' });
    expect(minersNeeded(room)).toBe(1);
  });
});

describe('haulersNeeded', () => {
  it('returns 0 when no sources', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(haulersNeeded(room)).toBe(0);
  });

  it('returns 0 when no containers', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10 }] },
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(haulersNeeded(room)).toBe(0);
  });

  it('returns 3 per unlinked source at low capacity', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 550 });
    expect(haulersNeeded(room)).toBe(3);
  });

  it('returns 2 per unlinked source at high capacity', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2);
  });

  it('adds extra hauler when mineral container exists', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        mineralContainerId: 'mcnt1' as any,
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(3);
  });

  it('adds extra hauler when labs exist', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(3);
  });

  it('only adds one extra hauler even with both minerals and labs', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        mineralContainerId: 'mcnt1' as any,
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(3);
  });
});

describe('upgradersNeeded', () => {
  it('returns 2 in bootstrap economy', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 1 when storage exists but is low', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      storage: { store: { getUsedCapacity: () => 5_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 1 when storage is between builder and upgrader thresholds', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      storage: { store: { getUsedCapacity: () => 12_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 2 when storage is moderate', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      storage: { store: { getUsedCapacity: () => 30_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('scales base with capacity when storage is healthy', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };

    const lowCap = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 500,
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(lowCap)).toBe(1);

    const midCap = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 800,
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(midCap)).toBe(2);

    const highCap = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(highCap)).toBe(3);
  });

  it('adds bonus for stored energy', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 800,
      storage: { store: { getUsedCapacity: () => 250_000 } },
    });
    // base 2 + bonus 2 (>200k)
    expect(upgradersNeeded(room)).toBe(4);
  });

  it('uses capacity-based formula when no storage exists', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 1500 });
    expect(upgradersNeeded(room)).toBe(3);
  });
});

describe('remoteBuilderNeeded', () => {
  it('returns false when room is not visible', () => {
    (Game as any).rooms = {};
    expect(remoteBuilderNeeded('W2N1')).toBe(false);
  });

  it('returns true when room has construction sites', () => {
    (Game as any).rooms = {
      W2N1: { find: vi.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [{}] : [])) },
    };
    (Game as any).creeps = {};
    expect(remoteBuilderNeeded('W2N1')).toBe(true);
  });

  it('returns false when a remote builder already exists for the room', () => {
    (Game as any).rooms = {
      W2N1: { find: vi.fn(() => [{}]) },
    };
    (Game as any).creeps = {
      rb1: { memory: { role: 'remoteBuilder', targetRoom: 'W2N1' } },
    };
    expect(remoteBuilderNeeded('W2N1')).toBe(false);
  });

  it('returns true when roads are heavily damaged', () => {
    const damagedRoad = { structureType: STRUCTURE_ROAD, hits: 1000, hitsMax: 5000 };
    (Game as any).rooms = {
      W2N1: {
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_CONSTRUCTION_SITES) return [];
          if (type === FIND_STRUCTURES) {
            const structs = [damagedRoad];
            return opts?.filter ? structs.filter(opts.filter) : structs;
          }
          return [];
        }),
      },
    };
    (Game as any).creeps = {};
    expect(remoteBuilderNeeded('W2N1')).toBe(true);
  });

  it('returns false when roads are healthy and no sites', () => {
    const healthyRoad = { structureType: STRUCTURE_ROAD, hits: 4000, hitsMax: 5000 };
    (Game as any).rooms = {
      W2N1: {
        find: vi.fn((type: number, opts?: any) => {
          if (type === FIND_CONSTRUCTION_SITES) return [];
          if (type === FIND_STRUCTURES) {
            const structs = [healthyRoad];
            return opts?.filter ? structs.filter(opts.filter) : structs;
          }
          return [];
        }),
      },
    };
    (Game as any).creeps = {};
    expect(remoteBuilderNeeded('W2N1')).toBe(false);
  });
});
