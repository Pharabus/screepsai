import {
  buildSpawnQueue,
  huntersNeeded,
  keeperKillersNeeded,
  minersNeeded,
  haulersNeeded,
  upgradersNeeded,
  repairersNeeded,
  remoteBuilderNeeded,
  defenderComposition,
  remoteHaulersWanted,
  upgraderBoostWanted,
  reserveBoostLab,
} from '../../src/managers/spawner';
import { mockRoom, resetGameGlobals } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { resetColonyScoreCache } from '../../src/utils/colonyPlanner';

beforeEach(() => {
  resetGameGlobals();
  resetTickCache();
  resetColonyScoreCache();
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

  it('miner economy retires harvester when all miners are alive and harvesting', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    // Miner must be in HARVEST state — a miner in POSITION (transit) still
    // produces no energy and should leave the emergency harvester active.
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const harvester = queue.find((r) => r.role === 'harvester');

    expect(harvester?.minCount).toBe(0);
  });

  it('miner economy keeps emergency harvester when miner is in transit (POSITION state)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'POSITION' } },
    };

    const room = mockRoom({ name: 'W1N1' });
    const queue = buildSpawnQueue(room);
    const harvester = queue.find((r) => r.role === 'harvester');

    expect(harvester?.minCount).toBe(1);
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

  it('scout does not spawn when the colony is at its remote cap', () => {
    // 1 remote + low storage => remoteRoomCap is 1, so the colony is at cap and
    // must not scout — even though W3N1 is unscouted and findScoutTarget would
    // otherwise return it.
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
        remoteRooms: ['W2N1'],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };
    Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W3N1' }) as any;

    const room = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 20_000 } },
    });
    const queue = buildSpawnQueue(room);

    expect(queue.find((r) => r.role === 'scout')).toBeUndefined();
  });

  it('scout spawns when below remote cap with a room to explore', () => {
    // 1 remote + 150k storage => remoteRoomCap is 2, so the colony is below cap
    // and may scout for a second remote.
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
        remoteRooms: ['W2N1'],
      },
    };
    (Game as any).creeps = { miner_1: { memory: { role: 'miner' } } };
    Game.map.describeExits = () => ({ '1': 'W2N1', '3': 'W3N1' }) as any;

    const room = mockRoom({
      name: 'W1N1',
      storage: { store: { getUsedCapacity: () => 150_000 } },
    });
    const queue = buildSpawnQueue(room);

    expect(queue.find((r) => r.role === 'scout')).toBeDefined();
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

  it('returns 3 for unlinked source at low capacity with default dist (25 tiles)', () => {
    // dist=25, haulerCarry=200: ceil(25*2*10/200)=ceil(2.5)=3 → max(3,2)=3
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 550 });
    expect(haulersNeeded(room)).toBe(3);
  });

  it('returns 2 for unlinked source at high capacity with default dist (25 tiles)', () => {
    // dist=25, haulerCarry=400: ceil(25*2*10/400)=ceil(1.25)=2 → max(2,2)=2
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2);
  });

  it('scales to 3 haulers for a far unlinked source (pathDist=60, high capacity)', () => {
    // dist=60, haulerCarry=400: ceil(60*2*10/400)=ceil(3)=3 → max(3,2)=3
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 39, y: 20, containerId: 'cnt1' as any, pathDist: 60 }],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(3);
  });

  it('uses pathDist over the 25-tile default when present', () => {
    // dist=40, haulerCarry=400: ceil(40*2*10/400)=ceil(2)=2 (same as default here)
    // but dist=10 → ceil(10*2*10/400)=ceil(0.5)=1 → max(1,2)=2 (min enforced)
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, pathDist: 10 }],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2); // min(2) enforced even for close source
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

  it('does not add remote bonus when no remoteRooms set', () => {
    (Memory as any).rooms = {
      W1N1: { sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }] },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2); // baseline, no bonus
  });

  it('adds +1 hauler when 1 remote room is active', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        remoteRooms: ['W2N1'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(3); // 2 baseline + 1 remote
  });

  it('adds +2 haulers when 2 remote rooms are active', () => {
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any }],
        remoteRooms: ['W2N1', 'W1N2'],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(4); // 2 baseline + 2 remotes
  });

  it('caps per-source contribution at MAX_HAULERS_PER_SOURCE (5) for very distant source (pathDist=100)', () => {
    // dist=100, effectiveDist=ceil(100*1.5)=150 (>60 swamp correction), haulerCarry=400
    // uncapped: ceil(150*2*10/400) = ceil(7.5) = 8 → would return 8, now capped to 5
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 39, y: 20, containerId: 'cnt1' as any, pathDist: 100 }],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(5); // capped at MAX_HAULERS_PER_SOURCE
  });

  it('does not apply cap for a normal short-distance source (pathDist=25)', () => {
    // dist=25, haulerCarry=400: ceil(25*2*10/400) = ceil(1.25) = 2 → well below cap
    (Memory as any).rooms = {
      W1N1: {
        sources: [{ id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, pathDist: 25 }],
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
    expect(haulersNeeded(room)).toBe(2); // normal result, cap not reached
  });
});

describe('upgradersNeeded', () => {
  it('returns 2 in bootstrap economy', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 1 (not 0) when storage < 5k and controller is below RCL 8 (growing room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      controller: { level: 4, ticksToDowngrade: 50_000 },
      storage: { store: { getUsedCapacity: () => 4_999 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 0 when storage < 5k and controller is RCL 8 (fully built room pauses)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      energyCapacityAvailable: 1500,
      controller: { level: 8, ticksToDowngrade: 50_000 },
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

  it('returns 1 when storage is below 50k (mature RCL 7 room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 30_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 1 when storage is between 50k and 100k (mature RCL 7 room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 2 when storage is above 100k (mature RCL 7 room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 120_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 3 at 200k and 4 at 500k storage (mature RCL 7 room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const at200k = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 250_000 } },
    });
    expect(upgradersNeeded(at200k)).toBe(3);

    const at500k = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
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

// ---------------------------------------------------------------------------
// Young-colony upgrade investment truth table
// ---------------------------------------------------------------------------

describe('upgradersNeeded — young colony (RCL < 6)', () => {
  /** Creates a room with 2 active-miner sources so score > YOUNG_COLONY_MIN_SCORE. */
  function youngRoomWithIncome(stored: number, rcl = 4): any {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' },
          { id: 's2', x: 20, y: 10, containerId: 'c2', minerName: 'm2' },
        ],
      },
    };
    (Game as any).creeps = {
      m1: { name: 'm1', memory: { role: 'miner' } },
      m2: { name: 'm2', memory: { role: 'miner' } },
    };
    return mockRoom({
      name: 'W1N1',
      controller: { level: rcl, ticksToDowngrade: 50_000 },
      storage: { store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) } },
      find: vi.fn(() => []),
    });
  }

  beforeEach(() => {
    resetColonyScoreCache();
  });

  it('young colony with healthy income → more upgraders than 1 at moderate storage', () => {
    const room = youngRoomWithIncome(20_000);
    // stored=20k ≥ 15k threshold → should return 3
    expect(upgradersNeeded(room)).toBe(3);
  });

  it('young colony at hard floor (stored < 5k) → backs off to 1', () => {
    // Hard floor applies first, before score check
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 4, ticksToDowngrade: 50_000 },
      storage: { store: { getUsedCapacity: () => 3_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('young colony with income but construction sites + low storage → 1 (builders not starved)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' },
          { id: 's2', x: 20, y: 10, containerId: 'c2', minerName: 'm2' },
        ],
      },
    };
    (Game as any).creeps = {
      m1: { name: 'm1', memory: { role: 'miner' } },
      m2: { name: 'm2', memory: { role: 'miner' } },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 4, ticksToDowngrade: 50_000 },
      // stored=12k — above hard floor (5k) but below builder-guard threshold (20k)
      storage: { store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 12_000 : 0) } },
      // Construction sites present
      find: vi.fn((type: number) => (type === FIND_MY_CONSTRUCTION_SITES ? [{}] : [])),
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('young colony with income, construction sites, but high storage → pushes harder (3)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 's1', x: 10, y: 10, containerId: 'c1', minerName: 'm1' },
          { id: 's2', x: 20, y: 10, containerId: 'c2', minerName: 'm2' },
        ],
      },
    };
    (Game as any).creeps = {
      m1: { name: 'm1', memory: { role: 'miner' } },
      m2: { name: 'm2', memory: { role: 'miner' } },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 4, ticksToDowngrade: 50_000 },
      // stored=25k — above the 20k builder-guard threshold
      storage: { store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 25_000 : 0) } },
      find: vi.fn((type: number) => (type === FIND_MY_CONSTRUCTION_SITES ? [{}] : [])),
    });
    expect(upgradersNeeded(room)).toBe(3);
  });

  it('young income-starved colony (no miners) → conservative 1', () => {
    // score = 0 → falls back to single upgrader regardless of storage
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 4 },
      storage: { store: { getUsedCapacity: () => 50_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('mature RCL-7 room with 30k storage → unchanged at 1 (W43N58 behavior)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 30_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('mature RCL-7 room with 110k storage → unchanged at 2', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 110_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });
});

describe('remoteBuilderNeeded', () => {
  it('returns false when room is not visible', () => {
    (Game as any).rooms = {};
    expect(remoteBuilderNeeded('W2N1')).toBe(false);
  });

  it('returns true when room has construction sites', () => {
    (Game as any).rooms = {
      W2N1: { find: vi.fn((type: number) => (type === FIND_MY_CONSTRUCTION_SITES ? [{}] : [])) },
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

  describe('colony expansion queueing', () => {
    it('queues a claimer for a claiming colony when none is alive', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 1 },
      };
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      const claimerEntry = queue.find((r) => r.role === 'claimer');

      expect(claimerEntry).toBeDefined();
      expect((claimerEntry?.memory as any)?.targetRoom).toBe('W2N1');
      expect(claimerEntry?.body).toEqual([CLAIM, MOVE, MOVE, MOVE, MOVE, MOVE]);
    });

    it('does not queue a claimer when one is already alive for the target', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 1 },
      };
      (Game as any).creeps = {
        claimer_1: { memory: { role: 'claimer', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      };

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
    });

    it('does not queue a claimer when energy capacity is below 850', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 1 },
      };
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
    });

    it('queues colonyBuilders for a bootstrapping colony with no spawn', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 1, claimedAt: 100 },
      };
      (Game as any).creeps = {};
      // No visibility to W2N1 — colonyBuildersWanted defaults to 2
      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 1300 });
      const queue = buildSpawnQueue(room);
      const builderEntry = queue.find((r) => r.role === 'colonyBuilder');

      expect(builderEntry).toBeDefined();
      expect((builderEntry?.memory as any)?.targetRoom).toBe('W2N1');
      expect(builderEntry?.minCount).toBe(2);
    });

    it('drops to 1 colonyBuilder once a spawn exists in the colony', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 1, claimedAt: 100 },
      };
      (Game as any).creeps = {};
      (Game as any).rooms = {
        W1N1: { name: 'W1N1', controller: { my: true } },
        W2N1: {
          name: 'W2N1',
          controller: { my: true },
          find: (type: number) => (type === FIND_MY_SPAWNS ? [{ name: 'colSpawn1' }] : []),
        },
      };

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 1300 });
      const queue = buildSpawnQueue(room);
      const builderEntry = queue.find((r) => r.role === 'colonyBuilder');

      expect(builderEntry?.minCount).toBe(1);
    });

    it('skips queueing for active colonies', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: {
          homeRoom: 'W1N1',
          status: 'active',
          selectedAt: 1,
          claimedAt: 100,
          activeAt: 200,
        },
      };
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
      expect(queue.find((r) => r.role === 'colonyBuilder')).toBeUndefined();
    });

    it('does not queue colony roles for a different home room', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      (Memory as any).colonies = {
        W2N1: { homeRoom: 'W9N9', status: 'claiming', selectedAt: 1 },
      };
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
    });
  });
});

describe('huntersNeeded', () => {
  it('returns 0 when no invaders present', () => {
    (Memory as any).rooms = { W1N1: { remoteRooms: ['W2N1'] }, W2N1: {} };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(0);
  });

  it('returns 0 when invaderSeenAt is stale (>500 ticks)', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { invaderSeenAt: 400 }, // 600 ticks ago — stale
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(0);
  });

  it('returns 1 when a remote room has a recent invader', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { invaderSeenAt: 900 }, // 100 ticks ago — active
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(1);
  });

  it('returns 1 when a transit room for an active colony has an invader', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: {},
      W1N2: { invaderSeenAt: 950 },
    };
    (Memory as any).colonies = {
      W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 1, transitRooms: ['W1N2'] },
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(1);
  });

  it('watches transit rooms for active colonies (inter-colony traffic still uses them)', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: {},
      W1N2: { invaderSeenAt: 950 },
    };
    (Memory as any).colonies = {
      W2N1: { homeRoom: 'W1N1', status: 'active', selectedAt: 1, transitRooms: ['W1N2'] },
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(1);
  });

  it('counts distinct infested rooms (not duplicate targets)', () => {
    (Game as any).time = 1000;
    // Both a remote and a transit room have invaders — 2 targets
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W3N1'] },
      W3N1: { invaderSeenAt: 900 },
      W1N2: { invaderSeenAt: 950 },
    };
    (Memory as any).colonies = {
      W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 1, transitRooms: ['W1N2'] },
    };
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(2);
  });

  it('queues hunter in buildSpawnQueue when invader is present', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W2N1'] },
      W2N1: { invaderSeenAt: 900 },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 1500 });
    const queue = buildSpawnQueue(room);
    const hunterEntry = queue.find((r) => r.role === 'hunter');
    expect(hunterEntry).toBeDefined();
    expect(hunterEntry?.memory?.targetRoom).toBe('W2N1');
  });
});

describe('remoteHaulersWanted', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('falls back to flat formula (3 per source) when remoteDistance is missing for reserved', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, true)).toBe(3);
  });

  it('falls back to flat formula (2 per source) when remoteDistance is missing for non-reserved', () => {
    (Memory as any).rooms = { W1N1: {} };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, false)).toBe(2);
  });

  it('preserves lower bound (3) for short distance (~30 tiles) reserved room', () => {
    // roundTripTicks = 30 tiles × 4 = 120
    // haulerBody at 2300e: [CARRY×2, MOVE×2] × 8 = 16 CARRY → 800 carry capacity
    // ceil(120 × 10 / 800) = ceil(1.5) = 2; Math.max(3, 2) = 3 (lower bound wins)
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 120 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, true)).toBe(3);
  });

  it('scales above lower bound for long distance (~70 tiles) reserved room', () => {
    // roundTripTicks = 70 tiles × 4 = 280
    // haulerBody at 2300e: 16 CARRY → 800 carry capacity
    // ceil(280 × 10 / 800) = ceil(3.5) = 4; Math.max(3, 4) = 4
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 280 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, true)).toBeGreaterThanOrEqual(4);
  });

  it('scales with sourceCount (2 sources at long distance)', () => {
    // haulersPerSource = 4 (Math.max(3, ceil(3.5))), × 2 sources = 8
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 280 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 2, true)).toBe(8);
  });

  it('uses lower sourceRate and preserves lower bound for non-reserved room', () => {
    // roundTripTicks = 200, sourceRate = 5, carryCapacity = 800
    // ceil(200 × 5 / 800) = ceil(1.25) = 2; Math.max(2, 2) = 2
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 200 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, false)).toBe(2);
  });

  it('never returns below flat lower bound even for trivially short distance', () => {
    // roundTripTicks = 4 → ceil(4 × 5 / 800) = 1; Math.max(2, 1) = 2
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 4 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, false)).toBe(2);
  });

  it('SK room (isHighCapacity=true) 3 sources at short distance hits flat floor of 9', () => {
    // roundTripTicks = 100, sourceRate = 10, carryCapacity = 800 at 2300e
    // ceil(100 × 10 / 800) = ceil(1.25) = 2; Math.max(3, 2) = 3 per source → 3 × 3 = 9
    (Memory as any).rooms = { W1N1: { remoteDistance: { SK1: 100 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'SK1', 3, true)).toBe(9);
  });

  it('SK room scales above floor for long distance (remoteDistance=320)', () => {
    // roundTripTicks = 320, sourceRate = 10, carryCapacity = 800
    // ceil(320 × 10 / 800) = 4 per source; 4 × 3 = 12
    (Memory as any).rooms = { W1N1: { remoteDistance: { SK1: 320 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'SK1', 3, true)).toBe(12);
  });

  it('caps per-source haulers at MAX_HAULERS_PER_SOURCE (5) for very long roundTripTicks', () => {
    // roundTripTicks = 800, sourceRate = 10, carryCapacity = 800
    // uncapped: ceil(800 × 10 / 800) = 10; Math.max(3, 10) = 10; capped to 5
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 800 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, true)).toBe(5);
  });

  it('cap applies per-source so 2 very-distant sources yields 2×MAX cap (10)', () => {
    // roundTripTicks = 800 → uncapped 10 per source; capped to 5 per source; 2 sources → 10
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 800 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 2, true)).toBe(10);
  });

  it('cap does not affect short-distance remotes (normal result preserved)', () => {
    // roundTripTicks = 120, sourceRate = 10, carryCapacity = 800
    // ceil(120 × 10 / 800) = 2; Math.max(3, 2) = 3 (lower bound wins) — well below cap
    (Memory as any).rooms = { W1N1: { remoteDistance: { W2N1: 120 } } };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    expect(remoteHaulersWanted(room, 'W2N1', 1, true)).toBe(3);
  });
});

describe('keeperKillersNeeded', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('returns 0 when energyCapacityAvailable < 5300', () => {
    (Memory as any).rooms = { W1N1: { remoteRooms: ['W0N0'] }, W0N0: { scoutedHasKeepers: true } };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 5299 });
    expect(keeperKillersNeeded(room)).toBe(0);
  });

  it('returns 0 when no remoteRooms have scoutedHasKeepers', () => {
    (Memory as any).rooms = { W1N1: { remoteRooms: ['W2N1'] }, W2N1: {} };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    expect(keeperKillersNeeded(room)).toBe(0);
  });

  it('returns 0 when remoteRooms is empty', () => {
    (Memory as any).rooms = { W1N1: {} };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    expect(keeperKillersNeeded(room)).toBe(0);
  });

  it('returns 1 when one SK remote has no assigned killer', () => {
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W0N0'] },
      W0N0: { scoutedHasKeepers: true },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    expect(keeperKillersNeeded(room)).toBe(1);
  });

  it('returns 0 when a killer is already assigned to the SK remote', () => {
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W0N0'] },
      W0N0: { scoutedHasKeepers: true },
    };
    (Game as any).creeps = {
      kk1: {
        name: 'kk1',
        memory: { role: 'keeperKiller', homeRoom: 'W1N1', targetRoom: 'W0N0' },
        room: { name: 'W0N0' },
      },
    };
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    expect(keeperKillersNeeded(room)).toBe(0);
  });

  it('returns 2 when two SK remotes each lack a killer', () => {
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W0N0', 'W0N1'] },
      W0N0: { scoutedHasKeepers: true },
      W0N1: { scoutedHasKeepers: true },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    expect(keeperKillersNeeded(room)).toBe(2);
  });

  it('queues keeperKiller in buildSpawnQueue when SK remote has no killer', () => {
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W0N0'], minerEconomy: true },
      W0N0: { scoutedHasKeepers: true },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 7000 });
    const queue = buildSpawnQueue(room);
    const entry = queue.find((r) => r.role === 'keeperKiller');
    expect(entry).toBeDefined();
    expect(entry?.memory?.targetRoom).toBe('W0N0');
    expect(entry?.memory?.homeRoom).toBe('W1N1');
  });

  it('does not queue keeperKiller when energyCapacityAvailable < 5300', () => {
    (Memory as any).rooms = {
      W1N1: { remoteRooms: ['W0N0'], minerEconomy: true },
      W0N0: { scoutedHasKeepers: true },
    };
    (Game as any).creeps = {};
    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 5000 });
    const queue = buildSpawnQueue(room);
    expect(queue.find((r) => r.role === 'keeperKiller')).toBeUndefined();
  });
});

describe('upgraderBoostWanted', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  function baseRoomMem() {
    return {
      minerEconomy: true,
      inputLabIds: ['lab1', 'lab2'] as any[],
      labIds: ['lab1', 'lab2', 'lab3', 'lab4'] as any[],
    };
  }

  function baseRoom(overrides: Record<string, any> = {}) {
    return mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
      ...overrides,
    });
  }

  it('returns true when all conditions are met (RCL 7, 2 output labs, GH2O >= 1500, energy > floor)', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom();
    expect(upgraderBoostWanted(room)).toBe(true);
  });

  it('returns false at RCL 6 (only 1 output lab would be reserved)', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom({ controller: { level: 6, my: true } });
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('returns false when fewer than 2 output labs available (labIds - inputLabIds < 2)', () => {
    (Memory as any).rooms = {
      W1N1: {
        ...baseRoomMem(),
        labIds: ['lab1', 'lab2', 'lab3'], // only 1 output lab
      },
    };
    const room = baseRoom();
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('returns false when GH2O stock is below BOOST_LAB_MINERAL_TARGET (1500)', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 500 : 0),
        },
      },
    });
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('counts GH2O across both storage and terminal', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 800 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (r: string) => (r === 'GH2O' ? 800 : 0) },
      },
    });
    // 800 + 800 = 1600 >= 1500
    expect(upgraderBoostWanted(room)).toBe(true);
  });

  it('counts GH2O already loaded in the reserved boost lab toward the threshold (no flip-flop)', () => {
    // Reserving the lab moves up to 1500 GH2O out of storage into it. A storage-only
    // sum would drop to the threshold and close the gate the moment a boost is
    // consumed, releasing the lab. The lab's GH2O must count so the sum is invariant.
    (Memory as any).rooms = { W1N1: { ...baseRoomMem(), boostLabId: 'lab3' } };
    const boostLab = {
      id: 'lab3',
      mineralType: 'GH2O',
      store: { getUsedCapacity: (r: string) => (r === 'GH2O' ? 600 : 0) },
    };
    (Game as any).getObjectById = vi.fn((id: string) => (id === 'lab3' ? boostLab : null));
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 1000 : 0),
        },
      },
    });
    // storage 1000 + terminal 0 + boost lab 600 = 1600 >= 1500
    expect(upgraderBoostWanted(room)).toBe(true);
  });

  it('returns false when storage+terminal+boostLab GH2O is below threshold', () => {
    (Memory as any).rooms = { W1N1: { ...baseRoomMem(), boostLabId: 'lab3' } };
    const boostLab = {
      id: 'lab3',
      mineralType: 'GH2O',
      store: { getUsedCapacity: (r: string) => (r === 'GH2O' ? 300 : 0) },
    };
    (Game as any).getObjectById = vi.fn((id: string) => (id === 'lab3' ? boostLab : null));
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 1000 : 0),
        },
      },
    });
    // 1000 + 0 + 300 = 1300 < 1500
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('ignores the boost lab when it holds a non-GH2O mineral', () => {
    (Memory as any).rooms = { W1N1: { ...baseRoomMem(), boostLabId: 'lab3' } };
    const boostLab = {
      id: 'lab3',
      mineralType: 'OH',
      store: { getUsedCapacity: (r: string) => (r === 'OH' ? 2000 : 0) },
    };
    (Game as any).getObjectById = vi.fn((id: string) => (id === 'lab3' ? boostLab : null));
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 1000 : 0),
        },
      },
    });
    // storage 1000 GH2O only; lab holds OH (ignored) => 1000 < 1500
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('returns false when storage energy is at or below STORAGE_ENERGY_FLOOR (10k)', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 10_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
    });
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('returns false when no controller', () => {
    (Memory as any).rooms = { W1N1: baseRoomMem() };
    const room = baseRoom({ controller: null });
    expect(upgraderBoostWanted(room)).toBe(false);
  });
});

describe('reserveBoostLab', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('sets boostLabId to an output lab and boostCompound to GH2O when boost is wanted', () => {
    const lab3 = { id: 'lab3', mineralType: null, store: { getUsedCapacity: () => 0 } };
    const lab4 = { id: 'lab4', mineralType: null, store: { getUsedCapacity: () => 0 } };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab3') return lab3;
      if (id === 'lab4') return lab4;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
      },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
    });

    reserveBoostLab(room);

    const mem = Memory.rooms['W1N1'];
    expect(mem.boostLabId).toBeDefined();
    // Must be an output lab, not an input lab
    expect(['lab1', 'lab2']).not.toContain(mem.boostLabId);
    expect(['lab3', 'lab4']).toContain(mem.boostLabId);
    expect(mem.boostCompound).toBe('GH2O');
  });

  it('never sets boostLabId to an input lab', () => {
    const lab1 = { id: 'lab1', mineralType: null, store: { getUsedCapacity: () => 0 } };
    const lab2 = { id: 'lab2', mineralType: null, store: { getUsedCapacity: () => 0 } };
    const lab3 = { id: 'lab3', mineralType: null, store: { getUsedCapacity: () => 0 } };
    const lab4 = { id: 'lab4', mineralType: null, store: { getUsedCapacity: () => 0 } };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab1') return lab1;
      if (id === 'lab2') return lab2;
      if (id === 'lab3') return lab3;
      if (id === 'lab4') return lab4;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
      },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
    });

    reserveBoostLab(room);

    const mem = Memory.rooms['W1N1'];
    expect(mem.boostLabId).not.toBe('lab1');
    expect(mem.boostLabId).not.toBe('lab2');
  });

  it('clears boostLabId and boostCompound when boost is not wanted (low GH2O)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
        boostLabId: 'lab3' as any,
        boostCompound: 'GH2O' as any,
      },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      storage: {
        // GH2O only 100 — below threshold
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 100 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
    });

    reserveBoostLab(room);

    const mem = Memory.rooms['W1N1'];
    expect(mem.boostLabId).toBeUndefined();
    expect(mem.boostCompound).toBeUndefined();
  });

  it('retains a valid existing boostLabId without churn', () => {
    const lab3 = { id: 'lab3', mineralType: 'GH2O' as any, store: { getUsedCapacity: () => 1000 } };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab3') return lab3;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
        boostLabId: 'lab3' as any,
      },
    };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
    });

    reserveBoostLab(room);

    const mem = Memory.rooms['W1N1'];
    expect(mem.boostLabId).toBe('lab3');
    expect(mem.boostCompound).toBe('GH2O');
  });
});

describe('buildSpawnQueue — upgrader boost memory', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  it('stamps memory.boosts on the upgrader request when boost is wanted', () => {
    const lab3 = { id: 'lab3', mineralType: null, store: { getUsedCapacity: () => 0 } };
    const lab4 = { id: 'lab4', mineralType: null, store: { getUsedCapacity: () => 0 } };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'lab3') return lab3;
      if (id === 'lab4') return lab4;
      return null;
    });
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      energyCapacityAvailable: 2300,
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
      terminal: {
        store: { getUsedCapacity: (_r: string) => 0 },
      },
    });

    const queue = buildSpawnQueue(room);
    const upgraderEntry = queue.find((r) => r.role === 'upgrader');

    expect(upgraderEntry).toBeDefined();
    expect(upgraderEntry?.memory?.boosts).toEqual([{ part: WORK, compound: 'GH2O' }]);
  });

  it('omits memory.boosts on the upgrader request when boost is not wanted (RCL 6)', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6, my: true }, // RCL 6 — boost not wanted
      energyCapacityAvailable: 2300,
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 2000 : 0),
        },
      },
    });

    const queue = buildSpawnQueue(room);
    const upgraderEntry = queue.find((r) => r.role === 'upgrader');

    expect(upgraderEntry).toBeDefined();
    expect(upgraderEntry?.memory).toBeUndefined();
  });

  it('omits memory.boosts when GH2O stock is below threshold', () => {
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
        ],
        inputLabIds: ['lab1', 'lab2'],
        labIds: ['lab1', 'lab2', 'lab3', 'lab4'],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      energyCapacityAvailable: 2300,
      storage: {
        // Only 500 GH2O — below 1500 threshold
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 500 : 0),
        },
      },
    });

    const queue = buildSpawnQueue(room);
    const upgraderEntry = queue.find((r) => r.role === 'upgrader');

    expect(upgraderEntry).toBeDefined();
    expect(upgraderEntry?.memory).toBeUndefined();
  });
});
