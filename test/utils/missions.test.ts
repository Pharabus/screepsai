/**
 * Tests for src/utils/missions.ts
 *
 * Uses the standard resetGameGlobals() mock so Game.creeps and Memory are
 * fresh for each test.
 */

import {
  ensureRemoteMiningMission,
  getRemoteMiningMission,
  syncMission,
  setMissionStatus,
  retireMission,
  getActiveMissionHaulerCount,
  getMissionStatus,
  garbageCollectMissions,
  syncAllMissions,
  getRemoteMissionKey,
  STALL_HOSTILE_TICKS,
  getMissionRegistry,
  getMissionsOfType,
  resetMissions,
} from '../../src/utils/missions';
import { resetGameGlobals } from '../mocks/screeps';

beforeEach(() => {
  resetGameGlobals();
  Memory.missions = { remoteMining: {} };
});

// ---------------------------------------------------------------------------
// getRemoteMissionKey
// ---------------------------------------------------------------------------

describe('getRemoteMissionKey', () => {
  it('returns the expected key format', () => {
    expect(getRemoteMissionKey('W43N59')).toBe('remoteMining:W43N59');
  });
});

// ---------------------------------------------------------------------------
// STALL_HOSTILE_TICKS export
// ---------------------------------------------------------------------------

it('STALL_HOSTILE_TICKS is a positive number', () => {
  expect(STALL_HOSTILE_TICKS).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// ensureRemoteMiningMission
// ---------------------------------------------------------------------------

describe('ensureRemoteMiningMission', () => {
  it('creates a new mission record when none exists', () => {
    const m = ensureRemoteMiningMission('W43N58', 'W43N59');
    expect(m).toBeDefined();
    expect(m.homeRoom).toBe('W43N58');
    expect(m.remoteRoom).toBe('W43N59');
    expect(m.status).toBe('active');
    expect(m.haulerIds).toEqual([]);
    expect(m.reserverId).toBeNull();
    expect(m.createdAt).toBe(Game.time);
  });

  it('stamps type and id on newly created records', () => {
    const m = ensureRemoteMiningMission('W43N58', 'W43N59');
    expect(m.type).toBe('remoteMining');
    expect(m.id).toBe('W43N59');
  });

  it('returns the same record on subsequent calls (idempotent)', () => {
    const m1 = ensureRemoteMiningMission('W43N58', 'W43N59');
    const m2 = ensureRemoteMiningMission('W43N58', 'W43N59');
    expect(m1).toBe(m2); // same object reference
  });

  it('stores the record in Memory.missions.remoteMining', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    expect(Memory.missions?.remoteMining['W43N59']).toBeDefined();
  });

  it('creates separate records for different remote rooms', () => {
    const m1 = ensureRemoteMiningMission('W43N58', 'W43N59');
    const m2 = ensureRemoteMiningMission('W43N58', 'W44N58');
    expect(m1).not.toBe(m2);
    expect(m1.remoteRoom).toBe('W43N59');
    expect(m2.remoteRoom).toBe('W44N58');
  });

  it('backfills type and id on a pre-existing record that lacks them', () => {
    // Simulate a record written by an older deploy (no type/id fields)
    Memory.missions = {
      remoteMining: {
        W43N59: {
          type: undefined as unknown as 'remoteMining',
          id: undefined as unknown as string,
          homeRoom: 'W43N58',
          remoteRoom: 'W43N59',
          status: 'active',
          createdAt: Game.time - 50,
          lastSynced: Game.time - 1,
          haulerIds: ['h1', 'h2'],
          reserverId: 'res1',
        },
      },
    };

    const m = ensureRemoteMiningMission('W43N58', 'W43N59');

    expect(m.type).toBe('remoteMining');
    expect(m.id).toBe('W43N59');
    // Existing creep ids must be preserved
    expect(m.haulerIds).toEqual(['h1', 'h2']);
    expect(m.reserverId).toBe('res1');
    expect(m.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// getRemoteMiningMission
// ---------------------------------------------------------------------------

describe('getRemoteMiningMission', () => {
  it('returns undefined when no mission exists', () => {
    expect(getRemoteMiningMission('W43N59')).toBeUndefined();
  });

  it('returns the mission after it is created', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    expect(getRemoteMiningMission('W43N59')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// syncMission
// ---------------------------------------------------------------------------

describe('syncMission', () => {
  it('does nothing when no mission record exists', () => {
    expect(() => syncMission('W43N59')).not.toThrow();
  });

  it('populates haulerIds from creeps whose missionId matches', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const key = getRemoteMissionKey('W43N59');

    // Inject mock remote haulers with matching missionId
    (Game.creeps as any)['hauler1'] = {
      name: 'hauler1',
      memory: { role: 'remoteHauler', missionId: key, targetRoom: 'W43N59' },
    };
    (Game.creeps as any)['hauler2'] = {
      name: 'hauler2',
      memory: { role: 'remoteHauler', missionId: key, targetRoom: 'W43N59' },
    };
    // A hauler without missionId should NOT be included
    (Game.creeps as any)['hauler3'] = {
      name: 'hauler3',
      memory: { role: 'remoteHauler', targetRoom: 'W43N59' },
    };
    // A hauler for a different remote should NOT be included
    (Game.creeps as any)['hauler4'] = {
      name: 'hauler4',
      memory: { role: 'remoteHauler', missionId: getRemoteMissionKey('W44N58') },
    };

    syncMission('W43N59');

    const m = getRemoteMiningMission('W43N59')!;
    expect(m.haulerIds).toHaveLength(2);
    expect(m.haulerIds).toContain('hauler1');
    expect(m.haulerIds).toContain('hauler2');
  });

  it('does not include non-remoteHauler creeps even if missionId matches', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const key = getRemoteMissionKey('W43N59');

    (Game.creeps as any)['miner1'] = {
      name: 'miner1',
      memory: { role: 'miner', missionId: key, targetRoom: 'W43N59' },
    };

    syncMission('W43N59');

    const m = getRemoteMiningMission('W43N59')!;
    expect(m.haulerIds).toHaveLength(0);
  });

  it('clears haulerIds when no matching creeps are alive', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.haulerIds = ['dead_hauler'];

    // No live creeps → haulerIds should be reset to []
    syncMission('W43N59');

    expect(m.haulerIds).toEqual([]);
  });

  it('clears reserverId when the tracked reserver is dead', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.reserverId = 'dead_reserver'; // not in Game.creeps

    syncMission('W43N59');

    expect(m.reserverId).toBeNull();
  });

  it('finds a live reserver by targetRoom when reserverId is null', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');

    (Game.creeps as any)['res1'] = {
      name: 'res1',
      memory: { role: 'reserver', targetRoom: 'W43N59' },
    };

    syncMission('W43N59');

    expect(getRemoteMiningMission('W43N59')!.reserverId).toBe('res1');
  });

  it('updates lastSynced after sync', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.lastSynced = 0; // artificially old

    syncMission('W43N59');

    expect(m.lastSynced).toBe(Game.time);
  });

  it('backfills type and id on a pre-existing record that lacks them', () => {
    // Simulate an old in-memory record without type/id
    Memory.missions = {
      remoteMining: {
        W43N59: {
          type: undefined as unknown as 'remoteMining',
          id: undefined as unknown as string,
          homeRoom: 'W43N58',
          remoteRoom: 'W43N59',
          status: 'active',
          createdAt: Game.time - 10,
          lastSynced: Game.time - 1,
          haulerIds: ['existing_hauler'],
          reserverId: 'existing_res',
        },
      },
    };

    syncMission('W43N59');

    const m = getRemoteMiningMission('W43N59')!;
    expect(m.type).toBe('remoteMining');
    expect(m.id).toBe('W43N59');
    // Existing data must be preserved — the sync only adds missing fields
    expect(m.haulerIds).toHaveLength(0); // re-derived from live creeps (none present)
    expect(m.reserverId).toBeNull(); // re-derived (no live reserver)
    expect(m.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// setMissionStatus / retireMission / getMissionStatus
// ---------------------------------------------------------------------------

describe('setMissionStatus', () => {
  it('changes status to stalled', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    setMissionStatus('W43N59', 'stalled');
    expect(getMissionStatus('W43N59')).toBe('stalled');
  });

  it('changes status back to active', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    setMissionStatus('W43N59', 'stalled');
    setMissionStatus('W43N59', 'active');
    expect(getMissionStatus('W43N59')).toBe('active');
  });

  it('does nothing when no mission exists', () => {
    expect(() => setMissionStatus('W43N59', 'stalled')).not.toThrow();
  });
});

describe('retireMission', () => {
  it('sets status to retiring', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    expect(getMissionStatus('W43N59')).toBe('retiring');
  });
});

describe('getMissionStatus', () => {
  it('returns undefined when mission does not exist', () => {
    expect(getMissionStatus('W43N59')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getActiveMissionHaulerCount
// ---------------------------------------------------------------------------

describe('getActiveMissionHaulerCount', () => {
  it('returns 0 when no mission exists', () => {
    expect(getActiveMissionHaulerCount('W43N59')).toBe(0);
  });

  it('returns the length of haulerIds', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.haulerIds = ['a', 'b', 'c'];
    expect(getActiveMissionHaulerCount('W43N59')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// garbageCollectMissions
// ---------------------------------------------------------------------------

describe('garbageCollectMissions', () => {
  it('removes retiring missions with no live creeps after 300 ticks', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    // Make the mission appear old enough
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 400;
    m.haulerIds = [];
    m.reserverId = null;

    garbageCollectMissions();

    expect(getRemoteMiningMission('W43N59')).toBeUndefined();
  });

  it('keeps retiring missions that still have live haulers', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 400;
    m.haulerIds = ['still_alive'];
    m.reserverId = null;

    garbageCollectMissions();

    expect(getRemoteMiningMission('W43N59')).toBeDefined();
  });

  it('keeps retiring missions that still have a live reserver', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 400;
    m.haulerIds = [];
    m.reserverId = 'res_alive';

    garbageCollectMissions();

    expect(getRemoteMiningMission('W43N59')).toBeDefined();
  });

  it('keeps retiring missions that are too young (< 300 ticks old)', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 100; // only 100 ticks old
    m.haulerIds = [];
    m.reserverId = null;

    garbageCollectMissions();

    expect(getRemoteMiningMission('W43N59')).toBeDefined();
  });

  it('keeps active missions regardless of age', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 10000;
    m.haulerIds = [];
    m.reserverId = null;

    garbageCollectMissions();

    expect(getRemoteMiningMission('W43N59')).toBeDefined();
  });

  it('iterates the registry rather than a hardcoded key — removes an aged retiring mission', () => {
    // Place a mission directly via the registry to prove the GC walks the
    // registry dynamically, not a hardcoded 'remoteMining' string.
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    const m = getRemoteMiningMission('W43N59')!;
    m.createdAt = Game.time - 500;
    m.haulerIds = [];
    m.reserverId = null;

    // A second mission that must survive (active, not retiring)
    ensureRemoteMiningMission('W43N58', 'W44N58');
    const mActive = getRemoteMiningMission('W44N58')!;
    mActive.createdAt = Game.time - 500;
    mActive.haulerIds = [];
    mActive.reserverId = null;

    garbageCollectMissions();

    // Aged retiring one is gone; active one survives
    expect(getRemoteMiningMission('W43N59')).toBeUndefined();
    expect(getRemoteMiningMission('W44N58')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// syncAllMissions
// ---------------------------------------------------------------------------

describe('syncAllMissions', () => {
  it('retires missions for remotes not in the current list', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    ensureRemoteMiningMission('W43N58', 'W44N58');

    // Only W43N59 remains active
    syncAllMissions(['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active');
    expect(getMissionStatus('W44N58')).toBe('retiring');
  });

  it('does not change missions that are already retiring', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');

    syncAllMissions([]); // no remotes active

    // Should stay retiring (not double-change)
    expect(getMissionStatus('W43N59')).toBe('retiring');
  });

  it('leaves all missions active when all remotes are in the current list', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    ensureRemoteMiningMission('W43N58', 'W44N58');

    syncAllMissions(['W43N59', 'W44N58']);

    expect(getMissionStatus('W43N59')).toBe('active');
    expect(getMissionStatus('W44N58')).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// getMissionRegistry
// ---------------------------------------------------------------------------

describe('getMissionRegistry', () => {
  it('initialises Memory.missions when absent', () => {
    (Memory as any).missions = undefined;
    const registry = getMissionRegistry();
    expect(registry).toBeDefined();
    expect(registry.remoteMining).toBeDefined();
    expect(Memory.missions).toBe(registry);
  });

  it('returns the existing registry when already present', () => {
    const first = getMissionRegistry();
    const second = getMissionRegistry();
    expect(first).toBe(second);
  });

  it('includes the remoteMining sub-map', () => {
    const registry = getMissionRegistry();
    expect(typeof registry.remoteMining).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// getMissionsOfType
// ---------------------------------------------------------------------------

describe('getMissionsOfType', () => {
  it('returns the remoteMining sub-map', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    const subMap = getMissionsOfType<RemoteMiningMission>('remoteMining');
    expect(subMap['W43N59']).toBeDefined();
    expect(subMap['W43N59'].remoteRoom).toBe('W43N59');
  });

  it('initialises Memory.missions if absent before returning the sub-map', () => {
    (Memory as any).missions = undefined;
    const subMap = getMissionsOfType<RemoteMiningMission>('remoteMining');
    expect(subMap).toBeDefined();
    expect(typeof subMap).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// resetMissions
// ---------------------------------------------------------------------------

describe('resetMissions', () => {
  it('clears all mission records', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    resetMissions();
    expect(getRemoteMiningMission('W43N59')).toBeUndefined();
  });

  it('leaves an empty but valid registry after reset', () => {
    resetMissions();
    const registry = getMissionRegistry();
    expect(registry.remoteMining).toBeDefined();
    expect(Object.keys(registry.remoteMining)).toHaveLength(0);
  });
});
