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
  defenderBoostsWanted,
  remoteHaulersWanted,
  upgraderBoostWanted,
  reserveBoostLab,
  mineralMinersNeeded,
} from '../../src/managers/spawner';
import { mockRoom, resetGameGlobals, seedColony } from '../mocks/screeps';
import { resetTickCache } from '../../src/utils/tickCache';
import { resetColonyScoreCache } from '../../src/utils/colonyPlanner';
import { flushSegments } from '../../src/utils/segments';
import { recordHostile } from '../../src/utils/neighbors';
import {
  createTransportMission,
  resetMissions,
  TRANSPORT_DRAIN_ALL,
} from '../../src/utils/missions';

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

  it('does NOT spawn the emergency harvester on a miner gap when storage is healthy', () => {
    // Mature rich room: src2 lacks a miner (a gap), but storage is full — haulers
    // cover the gap from storage and the replacement miner arrives shortly, so no
    // harvester should be queued. Harvesters are emergency low-energy bootstrappers.
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
          { id: 'src2' as any, x: 20, y: 20, containerId: 'cnt2' as any }, // no miner → gap
        ],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 50000 : 0) },
      },
    });
    const queue = buildSpawnQueue(room);
    const harvester = queue.find((r) => r.role === 'harvester');

    expect(harvester?.minCount).toBe(0);
  });

  it('spawns the emergency harvester on a miner gap when own storage is below the floor', () => {
    // Same gap, but storage is below HARVESTER_EMERGENCY_STORAGE_FLOOR (5k) — a
    // genuine low-energy emergency where the harvester is the recovery lifeline.
    (Memory as any).rooms = {
      W1N1: {
        minerEconomy: true,
        sources: [
          { id: 'src1' as any, x: 10, y: 10, containerId: 'cnt1' as any, minerName: 'miner_1' },
          { id: 'src2' as any, x: 20, y: 20, containerId: 'cnt2' as any }, // no miner → gap
        ],
      },
    };
    (Game as any).creeps = {
      miner_1: { memory: { role: 'miner', homeRoom: 'W1N1', state: 'HARVEST' } },
    };

    const room = mockRoom({
      name: 'W1N1',
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 3000 : 0) },
      },
    });
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
      storage: { my: true, store: { getUsedCapacity: () => 150_000 } },
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

  it('returns 2 when storage is between 50k and 150k (mature RCL 7 room)', () => {
    // Old threshold was 100k; lowered to 50k now that FACTORY_ENERGY_FLOOR (120k)
    // sits above the upgrader band and no longer intercepts the surplus.
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 60_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 2 when storage is between 50k and 150k (upper band) for mature RCL 7 room', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 120_000 } },
    });
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('returns 3 at 250k and 4 at 600k storage (mature RCL 7 room)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const at250k = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 250_000 } },
    });
    expect(upgradersNeeded(at250k)).toBe(3);

    const at600k = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      storage: { store: { getUsedCapacity: () => 600_000 } },
    });
    expect(upgradersNeeded(at600k)).toBe(4);
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
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
      },
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
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 25_000 : 0) },
      },
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

// ---------------------------------------------------------------------------
// upgradersNeeded — holisticEconomy flag ON (continuous formula)
// ---------------------------------------------------------------------------

describe('upgradersNeeded — holisticEconomy ON (mature RCL6+)', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    (Memory as any).holisticEconomy = true;
  });

  function makeRcl7Room(stored: number, terminalE = 0, energyCap = 2300): any {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    return mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: energyCap,
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
      },
      terminal:
        terminalE > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? terminalE : 0) },
            }
          : undefined,
    });
  }

  // Hard floor still applies (flag-on does not touch the hard floor block)
  it('returns 1 when storage < 5k (hard floor — unchanged under flag)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7 },
      energyCapacityAvailable: 2300,
      storage: { my: true, store: { getUsedCapacity: () => 3_000 } },
    });
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('returns 1 when colonyEnergy is at the buffer (surplus=0)', () => {
    // RCL7 buffer=50k; stored=50k → surplus=0 → power=1 → n=ceil(1/15)=1
    const room = makeRcl7Room(50_000);
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('anchor: colonyEnergy=100k → 1 upgrader (surplus=50k, power=11, wParts=15, n=1)', () => {
    const room = makeRcl7Room(100_000);
    // surplus=50k, power=1+10=11, workParts=15, n=ceil(11/15)=1
    expect(upgradersNeeded(room)).toBe(1);
  });

  it('anchor: colonyEnergy=150k → 2 upgraders (surplus=100k, power=21, n=ceil(21/15)=2)', () => {
    const room = makeRcl7Room(150_000);
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('anchor: colonyEnergy=250k → 3 upgraders (surplus=200k, power=41, n=ceil(41/15)=3)', () => {
    const room = makeRcl7Room(250_000);
    expect(upgradersNeeded(room)).toBe(3);
  });

  it('anchor: colonyEnergy=400k → 4 upgraders (clamped at MAX_UPGRADERS=4)', () => {
    const room = makeRcl7Room(400_000);
    // surplus=350k, power=71, n=ceil(71/15)=5→clamp→4
    expect(upgradersNeeded(room)).toBe(4);
  });

  it('terminal energy counts toward colonyEnergy (storage=80k + terminal=80k = 160k → 2)', () => {
    const room = makeRcl7Room(80_000, 80_000);
    // colonyEnergy=160k, surplus=110k, power=23, workParts=15, n=ceil(23/15)=2
    expect(upgradersNeeded(room)).toBe(2);
  });

  it('never exceeds MAX_UPGRADERS=4 regardless of energy', () => {
    const room = makeRcl7Room(1_000_000);
    expect(upgradersNeeded(room)).toBeLessThanOrEqual(4);
  });

  it('is monotonically non-decreasing as colonyEnergy increases (no cliffs)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    let prev = 0;
    for (let stored = 0; stored <= 600_000; stored += 5_000) {
      resetTickCache();
      (Memory as any).holisticEconomy = true;
      const room = mockRoom({
        name: 'W1N1',
        controller: { level: 7 },
        energyCapacityAvailable: 2300,
        storage: {
          my: true,
          store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? stored : 0) },
        },
      });
      const n = upgradersNeeded(room);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  // RCL6 room with smaller energyCap (1800 → workParts=min(17,15)=15 at stored≥50k)
  it('RCL6 anchor: colonyEnergy=80k → 2 upgraders (surplus=55k, power=12, wParts=15, n=1)', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true } };
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6 },
      energyCapacityAvailable: 1800,
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 80_000 : 0) },
      },
    });
    // surplus=55k, power=1+11=12, workParts=15 (stored≥50k, cap=1800, (1800-100)/100=17 → 15)
    // n=ceil(12/15)=1
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
      // containerId set: haulers only spawn once the remote container is built.
      W2N1: {
        remoteType: 'reserved',
        sources: [{ id: 'src1' as any, x: 20, y: 20, containerId: 'cnt1' as any }],
      },
    };
    // 2 existing haulers for this room — still below quota of 3
    (Game as any).creeps = {
      rh1: {
        name: 'rh1',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
      rh2: {
        name: 'rh2',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
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
      W2N1: {
        remoteType: 'reserved',
        sources: [{ id: 'src1' as any, x: 20, y: 20, containerId: 'cnt1' as any }],
      },
    };
    // 3 existing haulers — at quota
    (Game as any).creeps = {
      rh1: {
        name: 'rh1',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
      rh2: {
        name: 'rh2',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
      rh3: {
        name: 'rh3',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
    };

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const haulerEntry = queue.find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(haulerEntry).toBeUndefined();
  });

  it('does not queue remoteHauler until the remote source container is built', () => {
    // Reserved room, below quota, but no containerId yet → the remote miner is
    // still building the container, so a hauler would have nothing to haul.
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: { remoteType: 'reserved', sources: [{ id: 'src1' as any, x: 20, y: 20 }] },
    };
    (Game as any).creeps = {};

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const noContainer = buildSpawnQueue(room).find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );
    expect(noContainer).toBeUndefined();

    // Once the container exists, the hauler is queued.
    (Memory as any).rooms.W2N1.sources[0].containerId = 'cnt1';
    const withContainer = buildSpawnQueue(room).find(
      (r) => r.role === 'remoteHauler' && (r.memory as any)?.targetRoom === 'W2N1',
    );
    expect(withContainer).toBeDefined();
  });

  it('stops queuing remoteHauler at 2 per source for non-reserved room', () => {
    (Memory as any).rooms = {
      W1N1: { minerEconomy: true, sources: [], remoteRooms: ['W2N1'] },
      W2N1: {
        remoteType: 'remote',
        sources: [{ id: 'src1' as any, x: 20, y: 20, containerId: 'cnt1' as any }],
      },
    };
    // 2 existing haulers — at quota for non-reserved
    (Game as any).creeps = {
      rh1: {
        name: 'rh1',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
      rh2: {
        name: 'rh2',
        memory: {
          role: 'remoteHauler',
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          missionId: 'remoteMining:W2N1',
        },
      },
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
      seedColony('W2N1', { homeRoom: 'W1N1', status: 'claiming' });
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
      seedColony('W2N1', { homeRoom: 'W1N1', status: 'claiming' });
      (Game as any).creeps = {
        claimer_1: { memory: { role: 'claimer', homeRoom: 'W1N1', targetRoom: 'W2N1' } },
      };

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
    });

    it('does not queue a claimer when energy capacity is below 850', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      seedColony('W2N1', { homeRoom: 'W1N1', status: 'claiming' });
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 800 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
    });

    it('queues colonyBuilders for a bootstrapping colony with no spawn', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      seedColony('W2N1', { homeRoom: 'W1N1', status: 'bootstrapping', claimedAt: 100 });
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
      seedColony('W2N1', { homeRoom: 'W1N1', status: 'bootstrapping', claimedAt: 100 });
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
      seedColony('W2N1', {
        homeRoom: 'W1N1',
        status: 'active',
        claimedAt: 100,
        activeAt: 200,
      });
      (Game as any).creeps = {};

      const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
      const queue = buildSpawnQueue(room);
      expect(queue.find((r) => r.role === 'claimer')).toBeUndefined();
      expect(queue.find((r) => r.role === 'colonyBuilder')).toBeUndefined();
    });

    it('does not queue colony roles for a different home room', () => {
      (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [] } };
      seedColony('W2N1', { homeRoom: 'W9N9', status: 'claiming' });
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
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'bootstrapping', transitRooms: ['W1N2'] });
    const room = mockRoom({ name: 'W1N1' });
    expect(huntersNeeded(room)).toBe(1);
  });

  it('watches transit rooms for active colonies (inter-colony traffic still uses them)', () => {
    (Game as any).time = 1000;
    (Memory as any).rooms = {
      W1N1: {},
      W1N2: { invaderSeenAt: 950 },
    };
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'active', transitRooms: ['W1N2'] });
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
    seedColony('W2N1', { homeRoom: 'W1N1', status: 'claiming', transitRooms: ['W1N2'] });
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
    // Reserving the lab moves up to 1500 GH2O out of storage into it. With the lab
    // reserved the maintain floor (500) applies; the lab's GH2O must count so a
    // storage that has been drained into the lab does not unreserve it. Storage
    // alone (200) is below the maintain floor — only counting the lab keeps it open.
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
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 200 : 0),
        },
      },
    });
    // storage 200 + terminal 0 + boost lab 600 = 800 >= maintain floor 500 (reserved)
    expect(upgraderBoostWanted(room)).toBe(true);
  });

  it('returns false when not yet reserved and GH2O is below the start threshold (1500)', () => {
    // No boostLabId => the full start threshold applies.
    (Memory as any).rooms = { W1N1: { ...baseRoomMem() } };
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 1300 : 0),
        },
      },
    });
    // 1300 < 1500 start threshold, lab not reserved
    expect(upgraderBoostWanted(room)).toBe(false);
  });

  it('keeps an already-reserved lab while GH2O stays above the maintain floor (hysteresis)', () => {
    // boostLabId set => maintain floor (500), not the 1500 start threshold. A single
    // boost consuming ~450 from the lab must not unreserve it mid-cycle.
    (Memory as any).rooms = { W1N1: { ...baseRoomMem(), boostLabId: 'lab3' } };
    const boostLab = {
      id: 'lab3',
      mineralType: 'GH2O',
      store: { getUsedCapacity: (r: string) => (r === 'GH2O' ? 700 : 0) },
    };
    (Game as any).getObjectById = vi.fn((id: string) => (id === 'lab3' ? boostLab : null));
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 100 : 0),
        },
      },
    });
    // storage 100 + lab 700 = 800 >= maintain 500, below start 1500 — hysteresis keeps it
    expect(upgraderBoostWanted(room)).toBe(true);
  });

  it('releases a reserved lab when GH2O falls below the maintain floor (500)', () => {
    (Memory as any).rooms = { W1N1: { ...baseRoomMem(), boostLabId: 'lab3' } };
    const boostLab = {
      id: 'lab3',
      mineralType: 'GH2O',
      store: { getUsedCapacity: (r: string) => (r === 'GH2O' ? 200 : 0) },
    };
    (Game as any).getObjectById = vi.fn((id: string) => (id === 'lab3' ? boostLab : null));
    const room = baseRoom({
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 100 : 0),
        },
      },
    });
    // storage 100 + lab 200 = 300 < maintain floor 500
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
          getUsedCapacity: (r: string) => (r === 'energy' ? 20_000 : r === 'GH2O' ? 300 : 0),
        },
      },
    });
    // storage 300 GH2O only; lab holds OH (ignored) => 300 < maintain floor 500
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

// ── Item 3: defenderBoostsWanted gate ────────────────────────────────────────

describe('defenderBoostsWanted', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    (Game as any).time = 200; // non-zero so segment age checks work
  });

  /** Record a hostile with the given username and threat score into the neighbor segment. */
  function recordPlayer(username: string, threatParts: number = 1): void {
    // Build a creep body with ATTACK parts to give a threat score > 0
    const body = Array.from({ length: threatParts }, () => ({ type: ATTACK, hits: 100 }));
    const creep = {
      owner: { username },
      body,
      room: { name: 'W1N1' },
    } as any;
    // recordHostile needs a Room argument too
    const room = { name: 'W1N1' } as any;
    recordHostile(creep, room);
    flushSegments();
  }

  it('returns false when room RCL < 7', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6, my: true },
      find: vi.fn(() => []),
    });
    expect(defenderBoostsWanted(room)).toBe(false);
  });

  it('returns false when no hostile creeps are present', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      find: vi.fn(() => []),
    });
    expect(defenderBoostsWanted(room)).toBe(false);
  });

  it('returns false for an Invader hostile (not a player)', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      find: vi.fn(() => [{ owner: { username: 'Invader' }, body: [{ type: ATTACK, hits: 100 }] }]),
    });
    expect(defenderBoostsWanted(room)).toBe(false);
  });

  it('returns false for a Source Keeper hostile', () => {
    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      find: vi.fn(() => [
        { owner: { username: 'Source Keeper' }, body: [{ type: ATTACK, hits: 100 }] },
      ]),
    });
    expect(defenderBoostsWanted(room)).toBe(false);
  });

  it('returns false when player is present but NOT classified aggressive', () => {
    // Record 1 attack — below the threshold to become aggressive (needs ≥3 or maxThreat ≥500)
    recordPlayer('NewEnemy', 1); // 1 ATTACK part → threatScore=80, attacks=1 → 'unknown'

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      find: vi.fn(() => [{ owner: { username: 'NewEnemy' }, body: [{ type: ATTACK, hits: 100 }] }]),
    });
    // 'unknown' hostility ≠ 'aggressive' → false
    expect(defenderBoostsWanted(room)).toBe(false);
  });

  it('returns true for RCL 7+ with an aggressive-classified player hostile present', () => {
    // Record 3 attacks to trigger 'aggressive' classification
    for (let i = 0; i < 3; i++) {
      (Game as any).time = 200 + i;
      recordPlayer('Bully', 1);
    }

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      find: vi.fn(() => [{ owner: { username: 'Bully' }, body: [{ type: ATTACK, hits: 100 }] }]),
    });
    expect(defenderBoostsWanted(room)).toBe(true);
  });

  it('returns true at RCL 8 as well', () => {
    for (let i = 0; i < 3; i++) {
      (Game as any).time = 300 + i;
      recordPlayer('Bully', 1);
    }

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 8, my: true },
      find: vi.fn(() => [{ owner: { username: 'Bully' }, body: [{ type: ATTACK, hits: 100 }] }]),
    });
    expect(defenderBoostsWanted(room)).toBe(true);
  });
});

describe('defender spawn queue boost attachment', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    resetColonyScoreCache();
    (Game as any).time = 200;
  });

  /**
   * Set up memory so defenders AND a healer are needed (high threat).
   * 8 ATTACK parts × 80 = 640 threat > 600 → comp = {melee:1, ranged:2, healer:1}.
   * lastThreatScore must also be > 600 so defendersNeeded() returns > 0.
   */
  function setupHighThreat(roomName: string): void {
    (Memory as any).rooms = {
      [roomName]: {
        threatLastSeen: (Game as any).time,
        lastThreatScore: 700, // > 600 → healer included in composition
      },
    };
  }

  /** 8 ATTACK parts on the hostile so defenderComposition sees threat > 600. */
  const highThreatBody = Array.from({ length: 8 }, () => ({ type: ATTACK, hits: 100 }));

  it('attaches boosts to rangedDefender and healer (NOT melee) when gate is open', () => {
    // Make 'Bully' aggressive (3+ attacks recorded)
    for (let i = 0; i < 3; i++) {
      (Game as any).time = 200 + i;
      const creep = { owner: { username: 'Bully' }, body: highThreatBody } as any;
      recordHostile(creep, { name: 'W1N1' } as any);
      flushSegments();
    }
    (Game as any).time = 203;

    setupHighThreat('W1N1');

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      energyCapacityAvailable: 1300,
      // find() must return the hostile so defenderComposition can read the body
      find: vi.fn(() => [{ owner: { username: 'Bully' }, body: highThreatBody }]),
    });

    const queue = buildSpawnQueue(room);

    const meleeEntry = queue.find((r) => r.role === 'defender');
    const rangedEntry = queue.find((r) => r.role === 'rangedDefender');
    const healerEntry = queue.find((r) => r.role === 'healer');

    // Melee must have no boosts
    expect(meleeEntry?.memory?.boosts).toBeUndefined();

    // rangedDefender should have KHO2 boost
    expect(rangedEntry?.memory?.boosts).toBeDefined();
    expect(rangedEntry?.memory?.boosts?.[0]?.compound).toBe('KHO2');
    expect(rangedEntry?.memory?.boosts?.[0]?.part).toBe(RANGED_ATTACK);

    // healer should have LHO2 boost
    expect(healerEntry?.memory?.boosts).toBeDefined();
    expect(healerEntry?.memory?.boosts?.[0]?.compound).toBe('LHO2');
    expect(healerEntry?.memory?.boosts?.[0]?.part).toBe(HEAL);
  });

  it('omits boosts when the aggressive-player gate is closed (Invader only)', () => {
    setupHighThreat('W1N1');

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 7, my: true },
      energyCapacityAvailable: 1300,
      find: vi.fn(() => [{ owner: { username: 'Invader' }, body: highThreatBody }]),
    });

    const queue = buildSpawnQueue(room);

    const rangedEntry = queue.find((r) => r.role === 'rangedDefender');
    const healerEntry = queue.find((r) => r.role === 'healer');

    // Invader → gate closed → no boosts attached
    expect(rangedEntry?.memory?.boosts).toBeUndefined();
    expect(healerEntry?.memory?.boosts).toBeUndefined();
  });

  it('omits boosts at RCL < 7 even if a player is aggressive', () => {
    // Record aggressive player
    for (let i = 0; i < 3; i++) {
      (Game as any).time = 200 + i;
      const creep = { owner: { username: 'Bully' }, body: highThreatBody } as any;
      recordHostile(creep, { name: 'W1N1' } as any);
      flushSegments();
    }
    (Game as any).time = 203;

    setupHighThreat('W1N1');

    const room = mockRoom({
      name: 'W1N1',
      controller: { level: 6, my: true }, // RCL 6 — gate closed
      energyCapacityAvailable: 1300,
      find: vi.fn(() => [{ owner: { username: 'Bully' }, body: highThreatBody }]),
    });

    const queue = buildSpawnQueue(room);
    const rangedEntry = queue.find((r) => r.role === 'rangedDefender');
    const healerEntry = queue.find((r) => r.role === 'healer');

    expect(rangedEntry?.memory?.boosts).toBeUndefined();
    expect(healerEntry?.memory?.boosts).toBeUndefined();
  });
});

describe('buildSpawnQueue — transport missions', () => {
  beforeEach(() => {
    resetMissions();
    (Game as any).map.getRoomLinearDistance = () => 3;
  });

  it('queues a courier from the destination room while a transport is active', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [], remoteRooms: [] } };
    (Game as any).creeps = {};
    createTransportMission('W2N1', 'W1N1', TRANSPORT_DRAIN_ALL); // dest = W1N1

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);
    const courierEntry = queue.find(
      (r) => r.role === 'courier' && (r.memory as any)?.targetRoom === 'W2N1',
    );

    expect(courierEntry).toBeDefined();
    expect((courierEntry!.memory as any).homeRoom).toBe('W1N1'); // spawns from dest
    expect((courierEntry!.memory as any).missionId).toBe('transport:W2N1->W1N1');
  });

  it('does not queue a courier for a transport whose dest is a different room', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [], remoteRooms: [] } };
    (Game as any).creeps = {};
    createTransportMission('W2N1', 'W9N9', TRANSPORT_DRAIN_ALL); // dest = W9N9, not W1N1

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);

    expect(queue.find((r) => r.role === 'courier')).toBeUndefined();
  });

  it('does not queue a courier once the delivered target is met', () => {
    (Memory as any).rooms = { W1N1: { minerEconomy: true, sources: [], remoteRooms: [] } };
    (Game as any).creeps = {};
    const m = createTransportMission('W2N1', 'W1N1', 100000);
    m.deliveredAmount = 100000;

    const room = mockRoom({ name: 'W1N1', energyCapacityAvailable: 2300 });
    const queue = buildSpawnQueue(room);

    expect(queue.find((r) => r.role === 'courier')).toBeUndefined();
  });
});

describe('mineralMinersNeeded', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
  });

  /** Build a room that passes all gates: RCL given, extractor present, storage above floor,
   *  mineralId + mineralContainerId set, mineral has stock, no live miner. */
  function makeMineralRoom(rcl: number, storedEnergy: number): any {
    const mineral = { mineralAmount: 10000 };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'min1') return mineral;
      return null;
    });
    const extractor = { structureType: STRUCTURE_EXTRACTOR };
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: rcl },
      storage: {
        store: {
          getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? storedEnergy : 0),
        },
      },
      find: vi.fn((_type: number, opts?: any) => {
        // FIND_MY_STRUCTURES used by mineralMinersNeeded extractor check
        const structs = [extractor];
        return opts?.filter ? structs.filter(opts.filter) : structs;
      }),
    });
    (Memory as any).rooms = {
      W1N1: {
        mineralId: 'min1' as any,
        mineralContainerId: 'mcnt1' as any,
      },
    };
    (Game as any).creeps = {};
    return room;
  }

  it('returns 1 at RCL 6 when storage energy is exactly at the 50k floor', () => {
    const room = makeMineralRoom(6, 50_000);
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('returns 0 at RCL 6 when storage energy is just below the 50k floor', () => {
    const room = makeMineralRoom(6, 49_999);
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('returns 1 at RCL 6 when storage energy is well above the 50k floor', () => {
    const room = makeMineralRoom(6, 80_000);
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('returns 0 at RCL 6 when storage energy is below old 100k floor but above new 50k floor (regression)', () => {
    // The old floor was 100k; with the new 50k floor a room at 60k must return 1.
    const room = makeMineralRoom(6, 60_000);
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('returns 1 at RCL 7 when storage energy meets the 70k floor', () => {
    const room = makeMineralRoom(7, 70_000);
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('returns 0 at RCL 7 when storage energy is below the 70k floor', () => {
    const room = makeMineralRoom(7, 69_999);
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('returns 0 when extractor is missing', () => {
    const mineral = { mineralAmount: 10000 };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'min1') return mineral;
      return null;
    });
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: { store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 80_000 : 0) } },
      find: vi.fn(() => []), // no extractor
    });
    (Memory as any).rooms = {
      W1N1: { mineralId: 'min1' as any, mineralContainerId: 'mcnt1' as any },
    };
    (Game as any).creeps = {};
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('returns 0 below RCL 6', () => {
    const room = makeMineralRoom(5, 200_000);
    expect(mineralMinersNeeded(room)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mineralMinersNeeded — holisticEconomy flag ON
// ---------------------------------------------------------------------------

describe('mineralMinersNeeded — holisticEconomy ON', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetTickCache();
    (Memory as any).holisticEconomy = true;
  });

  /** Build a room that passes all gates (extractor present, mineral has stock, no live miner).
   *  Under holisticEconomy the storage reads myStorage (requires my:true). */
  function makeMineralRoomHolistic(
    rcl: number,
    storageE: number,
    terminalE = 0,
    minerEconomy = true,
  ): any {
    const mineral = { mineralAmount: 10_000 };
    (Game as any).getObjectById = vi.fn((id: string) => {
      if (id === 'min1') return mineral;
      return null;
    });
    const extractor = { structureType: STRUCTURE_EXTRACTOR };
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: rcl },
      storage:
        storageE >= 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? storageE : 0) },
            }
          : undefined,
      terminal:
        terminalE > 0
          ? {
              my: true,
              store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? terminalE : 0) },
            }
          : undefined,
      find: vi.fn((_type: number, opts?: any) => {
        const structs = [extractor];
        return opts?.filter ? structs.filter(opts.filter) : structs;
      }),
    });
    (Memory as any).rooms = {
      W1N1: {
        mineralId: 'min1' as any,
        mineralContainerId: 'mcnt1' as any,
        ...(minerEconomy ? { minerEconomy: true } : {}),
      },
    };
    (Game as any).creeps = {};
    return room;
  }

  it('returns 0 when total energy is at the gate (buffer + MINERAL_RESERVE_MARGIN, not >) at RCL6', () => {
    // RCL6 buffer=25k, margin=15k, gate=40k; total=40k → not > gate → 0
    const room = makeMineralRoomHolistic(6, 40_000);
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('returns 1 when total energy is just above the gate at RCL6', () => {
    // total=40001 > 40k gate → allowed
    const room = makeMineralRoomHolistic(6, 40_001);
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('combined storage+terminal energy unlocks mining: storage=30k + terminal=15k = 45k > 40k gate', () => {
    const room = makeMineralRoomHolistic(6, 30_000, 15_000);
    // colonyEnergy=45k > buffer(25k)+margin(15k)=40k → allowed
    expect(mineralMinersNeeded(room)).toBe(1);
  });

  it('combined energy just at the gate (storage=25k+terminal=15k=40k) → does not mine', () => {
    const room = makeMineralRoomHolistic(6, 25_000, 15_000);
    // colonyEnergy=40k, not > 40k → disallowed
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('RCL7 gate: buffer=50k+margin=15k=65k; total=65k → 0, total=65001 → 1', () => {
    const at65k = makeMineralRoomHolistic(7, 65_000);
    expect(mineralMinersNeeded(at65k)).toBe(0);

    resetTickCache();
    (Memory as any).holisticEconomy = true;
    const above65k = makeMineralRoomHolistic(7, 65_001);
    expect(mineralMinersNeeded(above65k)).toBe(1);
  });

  it('still returns 0 when extractor is missing (holistic gate is checked after extractor)', () => {
    (Game as any).getObjectById = vi.fn(() => null);
    const room = mockRoom({
      name: 'W1N1',
      controller: { my: true, level: 6 },
      storage: {
        my: true,
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? 100_000 : 0) },
      },
      find: vi.fn(() => []), // no extractor
    });
    (Memory as any).rooms = {
      W1N1: { mineralId: 'min1' as any, mineralContainerId: 'mcnt1' as any, minerEconomy: true },
    };
    (Game as any).creeps = {};
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  it('still returns 0 below RCL 6 even with huge energy', () => {
    const room = makeMineralRoomHolistic(5, 500_000);
    expect(mineralMinersNeeded(room)).toBe(0);
  });

  // Explicit collision regression: RCL6 at the old 50k step (where old 2nd upgrader
  // threshold was equal to old mining floor) — under holisticEconomy the mining gate
  // is 40k which is BELOW 50k, so mining is already allowed when stored=50k,
  // regardless of upgrader count.
  it('collision regression: at the old 50k collision point, mining is still allowed', () => {
    // Old behavior: stored=50k at RCL6 → 2nd upgrader AND mining both fire (collision).
    // New behavior: mining gate=40k < 50k, so mining opens earlier, no collision.
    const room = makeMineralRoomHolistic(6, 50_000);
    // At stored=50k, colonyEnergy=50k > gate=40k → allowed
    expect(mineralMinersNeeded(room)).toBe(1);
  });
});
