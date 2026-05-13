import {
  buildSpawnQueue,
  minersNeeded,
  haulersNeeded,
  upgradersNeeded,
  repairersNeeded,
  remoteBuilderNeeded,
  defenderComposition,
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

  it('requests 0 builders when no construction sites exist', () => {
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
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 15000 : 0) },
      },
    });
    const queue = buildSpawnQueue(room);
    const builderEntry = queue.find((r) => r.role === 'builder');

    expect(builderEntry?.minCount).toBe(0);
  });

  it('requests builders when construction sites exist (unlinked, low storage)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };

    const site = { structureType: STRUCTURE_ROAD };
    const room = mockRoom({
      name: 'W1N1',
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 5000 : 0) },
      },
      find: vi.fn((type: number) => {
        if (type === FIND_MY_CONSTRUCTION_SITES) return [site];
        return [];
      }),
    });
    const queue = buildSpawnQueue(room);
    const builderEntry = queue.find((r) => r.role === 'builder');

    expect(builderEntry?.minCount).toBeGreaterThan(0);
  });

  it('requests builders when construction sites exist (all-linked, storage above floor)', () => {
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

    const site = { structureType: STRUCTURE_EXTENSION };
    const room = mockRoom({
      name: 'W1N1',
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 15000 : 0) },
      },
      find: vi.fn((type: number) => {
        if (type === FIND_MY_CONSTRUCTION_SITES) return [site];
        return [];
      }),
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

  it('miner economy retires harvester when all miners are alive', () => {
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

    expect(harvester?.minCount).toBe(0);
  });

  it('miner economy keeps emergency harvester when a source lacks a miner', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
          { id: 'src2' as any, x: 20, y: 20, containerId: 'cnt2' as any }, // no miner
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

  it('does not add extra hauler for mineral container (task commitment handles it)', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        mineralContainerId: 'mcnt1' as any,
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2);
  });

  it('does not add extra hauler for labs (task commitment handles it)', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2);
  });

  it('returns 2 with both mineral container and labs', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        mineralContainerId: 'mcnt1' as any,
        labIds: ['lab1', 'lab2', 'lab3'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2);
  });
});

describe('upgradersNeeded', () => {
  it('returns 2 in bootstrap economy', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 0 when storage exists but is below 5k (pause to let remotes refill)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      storage: { store: { getUsedCapacity: () => 4_999 } },
    });
    expect(upgradersNeeded(room)).toBe(0);
  });

  it('returns 1 when storage exists and is at/above 5k floor', () => {
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

  it('returns 1 when storage is below 50k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 30_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 1 when storage is between 50k and 100k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 2 when storage is above 100k', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 120_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 3 at 200k and 4 at 500k storage', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const at200k = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 250_000 } },
    });
    expect(upgradersNeeded(at200k)).toBe(3);

    const at500k = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 600_000 } },
    });
    expect(upgradersNeeded(at500k)).toBe(4);
  });

  it('returns 1 when no storage exists in miner economy', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({ name: 'W1N1' });
    expect(upgradersNeeded(room)).toBe(1);
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

describe('defenderComposition', () => {
  function makeHostile(parts: { type: BodyPartConstant; hits?: number }[]) {
    return {
      body: parts.map((p) => ({ type: p.type, hits: p.hits ?? 100 })),
    };
  }

  it('returns zero composition when no threat', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn(() => []),
    });
    const comp = defenderComposition(room);
    expect(comp).toEqual({ melee: 0, ranged: 0, healer: 0 });
  });

  it('returns melee only for low threat (<=200)', () => {
    (Memory as any).rooms = {
      W1N1: { threatLastSeen: 1, lastThreatScore: 80 },
    };
    const hostile = makeHostile([{ type: ATTACK }]);
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }),
    });
    (Game as any).time = 1;
    const comp = defenderComposition(room);
    expect(comp.melee).toBe(1);
    expect(comp.ranged).toBe(0);
    expect(comp.healer).toBe(0);
  });

  it('returns melee + ranged for moderate threat (200-600)', () => {
    (Memory as any).rooms = {
      W1N1: { threatLastSeen: 1, lastThreatScore: 400 },
    };
    const hostile = makeHostile([{ type: ATTACK }, { type: RANGED_ATTACK }, { type: MOVE }]);
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }),
    });
    (Game as any).time = 1;
    const comp = defenderComposition(room);
    expect(comp.melee).toBe(1);
    expect(comp.ranged).toBeGreaterThanOrEqual(1);
    expect(comp.healer).toBe(0);
  });

  it('returns melee + ranged + healer for high threat (>600)', () => {
    (Memory as any).rooms = {
      W1N1: { threatLastSeen: 1, lastThreatScore: 700 },
    };
    // HEAL(250) + HEAL(250) + RANGED_ATTACK(150) = 650
    const hostile = makeHostile([
      { type: HEAL },
      { type: HEAL },
      { type: RANGED_ATTACK },
      { type: MOVE },
    ]);
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }),
    });
    (Game as any).time = 1;
    const comp = defenderComposition(room);
    expect(comp.melee).toBeGreaterThanOrEqual(1);
    expect(comp.ranged).toBeGreaterThanOrEqual(1);
    expect(comp.healer).toBeGreaterThanOrEqual(1);
    // Total should not exceed 4
    expect(comp.melee + comp.ranged + comp.healer).toBeLessThanOrEqual(4);
  });

  it('bumps ranged when hostiles have HEAL parts', () => {
    (Memory as any).rooms = {
      W1N1: { threatLastSeen: 1, lastThreatScore: 330 },
    };
    // ATTACK(80) + HEAL(250) = 330 — moderate threat band with healer
    const hostile = makeHostile([{ type: ATTACK }, { type: HEAL }, { type: MOVE }]);
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      }),
    });
    (Game as any).time = 1;
    const comp = defenderComposition(room);
    expect(comp.ranged).toBeGreaterThanOrEqual(1);
  });
});

describe('repairersNeeded', () => {
  it('returns 0 when no structures are damaged', () => {
    const room = mockRoom({ name: 'W1N1' }); // find() returns [] by default
    expect(repairersNeeded(room)).toBe(0);
  });

  it('returns 1 when 1 to 5 structures are damaged', () => {
    const damaged = { structureType: STRUCTURE_ROAD, hits: 100, hitsMax: 1000 };
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES) {
          const structs = [damaged];
          return opts?.filter ? structs.filter(opts.filter) : structs;
        }
        return [];
      }),
    });
    expect(repairersNeeded(room)).toBe(1);
  });

  it('returns 2 when more than 5 structures are damaged', () => {
    const damaged = { structureType: STRUCTURE_ROAD, hits: 100, hitsMax: 1000 };
    const sixDamaged = Array(6).fill(damaged);
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES) {
          return opts?.filter ? sixDamaged.filter(opts.filter) : sixDamaged;
        }
        return [];
      }),
    });
    expect(repairersNeeded(room)).toBe(2);
  });

  it('does not count walls or ramparts as damaged', () => {
    const wall = { structureType: STRUCTURE_WALL, hits: 1, hitsMax: 300000000 };
    const rampart = { structureType: STRUCTURE_RAMPART, hits: 1, hitsMax: 300000000 };
    const room = mockRoom({
      name: 'W1N1',
      find: vi.fn((type: number, opts?: any) => {
        if (type === FIND_STRUCTURES) {
          const structs = [wall, rampart];
          return opts?.filter ? structs.filter(opts.filter) : structs;
        }
        return [];
      }),
    });
    expect(repairersNeeded(room)).toBe(0);
  });
});

describe('buildSpawnQueue — remote mining (reserved rooms)', () => {
  it('queues 10-WORK miner body for reserved remote room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'reserved', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    (Game as any).creeps = {};

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const remoteMiner = queue.find(
      (r) => r.role === 'miner' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(remoteMiner).toBeDefined();
    const workParts = remoteMiner!.body!.filter((p) => p === WORK).length;
    expect(workParts).toBe(10);
  });

  it('queues 5-WORK miner body for non-reserved remote room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'remote', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    (Game as any).creeps = {};

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const remoteMiner = queue.find(
      (r) => r.role === 'miner' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(remoteMiner).toBeDefined();
    const workParts = remoteMiner!.body!.filter((p) => p === WORK).length;
    expect(workParts).toBe(5);
  });

  it('queues remoteHauler when below quota of 3 for reserved room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'reserved', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    // 2 existing haulers for this room — still below quota of 3
    (Game as any).creeps = {
      rh1: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      rh2: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
    };

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const haulerEntry = queue.find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(haulerEntry).toBeDefined();
  });

  it('does not queue remoteHauler when at quota of 3 for reserved room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'reserved', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    // 3 existing haulers — at quota
    (Game as any).creeps = {
      rh1: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      rh2: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      rh3: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
    };

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const haulerEntry = queue.find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(haulerEntry).toBeUndefined();
  });

  it('stops queuing remoteHauler at 2 per source for non-reserved room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'remote', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    // 2 existing haulers — at quota for non-reserved
    (Game as any).creeps = {
      rh1: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      rh2: { memory: { role: 'remoteHauler', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
    };

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const haulerEntry = queue.find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(haulerEntry).toBeUndefined();
  });
});
