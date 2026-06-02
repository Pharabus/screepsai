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
  getTransportMissionKey,
  createTransportMission,
  getTransportMission,
  getTransportMissions,
  syncTransportMission,
  getActiveCourierCount,
  TRANSPORT_DRAIN_ALL,
} from '../../src/utils/missions';
import { resetGameGlobals } from '../mocks/screeps';

/** Minimal store stub: getUsedCapacity(resource?) returns `energy` for energy/total, else 0. */
const courierStore = (energy = 0): any => ({
  getUsedCapacity: (r?: string) => (r === undefined || r === RESOURCE_ENERGY ? energy : 0),
});

beforeEach(() => {
  resetGameGlobals();
  Memory.missions = { remoteMining: {}, colony: {} };
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
      colony: {},
      defense: {},
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
      colony: {},
      defense: {},
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
    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active');
    expect(getMissionStatus('W44N58')).toBe('retiring');
  });

  it('does not change missions that are already retiring', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');

    syncAllMissions('W43N58', []); // no remotes active

    // Should stay retiring (not double-change)
    expect(getMissionStatus('W43N59')).toBe('retiring');
  });

  it('leaves all missions active when all remotes are in the current list', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    ensureRemoteMiningMission('W43N58', 'W44N58');

    syncAllMissions('W43N58', ['W43N59', 'W44N58']);

    expect(getMissionStatus('W43N59')).toBe('active');
    expect(getMissionStatus('W44N58')).toBe('active');
  });

  it('reactivates a retiring mission whose room is re-selected (un-latch)', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    retireMission('W43N59');
    expect(getMissionStatus('W43N59')).toBe('retiring');

    // Room is back in the selection → recover the mission
    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active');
  });

  it('leaves a stalled mission stalled when its room is in the list (does not stomp spawner state)', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    setMissionStatus('W43N59', 'stalled');

    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('stalled');
  });

  it('leaves an active mission active when its room is in the list (no spurious churn)', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');

    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active');
  });

  it('retires a stalled mission whose room is NOT in the list', () => {
    ensureRemoteMiningMission('W43N58', 'W43N59');
    setMissionStatus('W43N59', 'stalled');

    syncAllMissions('W43N58', []); // no remotes active

    expect(getMissionStatus('W43N59')).toBe('retiring');
  });

  it("does not touch a different home room's missions (cross-home isolation)", () => {
    // Two colonies, each with one active remote.
    ensureRemoteMiningMission('W43N58', 'W43N59'); // home A
    ensureRemoteMiningMission('W44N57', 'W44N58'); // home B

    // Reconcile only home A. Home B's remote is not in A's list, but it must
    // NOT be retired because it belongs to a different home.
    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active');
    expect(getMissionStatus('W44N58')).toBe('active'); // untouched — not this home's mission
  });

  it("recovers only this home's retiring mission, leaving another home's retiring mission alone", () => {
    ensureRemoteMiningMission('W43N58', 'W43N59'); // home A
    ensureRemoteMiningMission('W44N57', 'W44N58'); // home B
    retireMission('W43N59');
    retireMission('W44N58');

    // Home A reconciles with its remote re-selected.
    syncAllMissions('W43N58', ['W43N59']);

    expect(getMissionStatus('W43N59')).toBe('active'); // recovered (this home)
    expect(getMissionStatus('W44N58')).toBe('retiring'); // untouched (other home)
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
    expect(registry.colony).toBeDefined();
    expect(registry.defense).toBeDefined();
    expect(Memory.missions).toBe(registry);
  });

  it('returns the existing registry when already present', () => {
    const first = getMissionRegistry();
    const second = getMissionRegistry();
    expect(first).toBe(second);
  });

  it('includes the remoteMining, colony, and defense sub-maps', () => {
    const registry = getMissionRegistry();
    expect(typeof registry.remoteMining).toBe('object');
    expect(typeof registry.colony).toBe('object');
    expect(typeof registry.defense).toBe('object');
  });

  it('backfills the colony and defense sub-maps on a registry created before they existed', () => {
    // Simulate older live memory: only remoteMining present.
    (Memory as any).missions = { remoteMining: {} };
    const registry = getMissionRegistry();
    expect(registry.colony).toBeDefined();
    expect(registry.defense).toBeDefined();
    expect(registry.remoteMining).toBeDefined();
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
    expect(registry.colony).toBeDefined();
    expect(registry.defense).toBeDefined();
    expect(registry.transport).toBeDefined();
    expect(Object.keys(registry.remoteMining)).toHaveLength(0);
    expect(Object.keys(registry.colony)).toHaveLength(0);
    expect(Object.keys(registry.defense)).toHaveLength(0);
    expect(Object.keys(registry.transport)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Transport missions
// ---------------------------------------------------------------------------

describe('transport missions', () => {
  beforeEach(() => {
    resetMissions();
  });

  it('getTransportMissionKey returns the expected format', () => {
    expect(getTransportMissionKey('W42N59', 'W43N58')).toBe('transport:W42N59->W43N58');
  });

  it('createTransportMission creates a record with the right shape', () => {
    const m = createTransportMission('W42N59', 'W43N58', 100000);
    expect(m.type).toBe('transport');
    expect(m.id).toBe('transport:W42N59->W43N58');
    expect(m.sourceRoom).toBe('W42N59');
    expect(m.destRoom).toBe('W43N58');
    expect(m.resource).toBe(RESOURCE_ENERGY);
    expect(m.targetAmount).toBe(100000);
    expect(m.deliveredAmount).toBe(0);
    expect(m.status).toBe('active');
    expect(m.courierIds).toEqual([]);
    expect(getTransportMission('transport:W42N59->W43N58')).toBe(m);
  });

  it('createTransportMission is idempotent and resets target/delivered/status on re-issue', () => {
    const first = createTransportMission('W42N59', 'W43N58', 50000);
    first.deliveredAmount = 40000;
    first.status = 'retiring';
    const again = createTransportMission('W42N59', 'W43N58', 200000);
    expect(again).toBe(first); // same record, not a duplicate
    expect(getTransportMissions()).toHaveLength(1);
    expect(again.targetAmount).toBe(200000);
    expect(again.deliveredAmount).toBe(0);
    expect(again.status).toBe('active');
  });

  it('TRANSPORT_DRAIN_ALL is a finite, JSON-safe sentinel (not Infinity)', () => {
    expect(Number.isFinite(TRANSPORT_DRAIN_ALL)).toBe(true);
    expect(JSON.parse(JSON.stringify({ a: TRANSPORT_DRAIN_ALL })).a).toBe(TRANSPORT_DRAIN_ALL);
  });

  it('syncTransportMission rebuilds courierIds from live creeps', () => {
    const m = createTransportMission('W42N59', 'W43N58', TRANSPORT_DRAIN_ALL);
    (Game as any).creeps = {
      c1: { name: 'c1', memory: { role: 'courier', missionId: m.id }, store: courierStore(0) },
      c2: { name: 'c2', memory: { role: 'courier', missionId: m.id }, store: courierStore(0) },
      other: { name: 'other', memory: { role: 'hauler', missionId: m.id }, store: courierStore(0) },
    };
    syncTransportMission(m.id);
    expect(m.courierIds.sort()).toEqual(['c1', 'c2']);
    expect(getActiveCourierCount(m.id)).toBe(2);
  });

  it('retires when deliveredAmount reaches the target', () => {
    const m = createTransportMission('W42N59', 'W43N58', 100000);
    m.deliveredAmount = 100000;
    (Game as any).creeps = {};
    syncTransportMission(m.id);
    expect(m.status).toBe('retiring');
  });

  it('retires when the source is visible-empty and no courier is carrying (exhausted)', () => {
    const m = createTransportMission('W42N59', 'W43N58', TRANSPORT_DRAIN_ALL);
    m.deliveredAmount = 73000; // short of "all" — ends via exhaustion, never hangs
    (Game as any).rooms = {
      W42N59: { storage: { store: { getUsedCapacity: () => 0 } }, terminal: undefined },
    };
    (Game as any).creeps = {
      c1: { name: 'c1', memory: { role: 'courier', missionId: m.id }, store: courierStore(0) },
    };
    syncTransportMission(m.id);
    expect(m.status).toBe('retiring');
  });

  it('does NOT retire on exhaustion while a courier still carries the resource', () => {
    const m = createTransportMission('W42N59', 'W43N58', TRANSPORT_DRAIN_ALL);
    (Game as any).rooms = {
      W42N59: { storage: { store: { getUsedCapacity: () => 0 } }, terminal: undefined },
    };
    (Game as any).creeps = {
      c1: {
        name: 'c1',
        memory: { role: 'courier', missionId: m.id },
        store: courierStore(200),
      },
    };
    syncTransportMission(m.id);
    expect(m.status).toBe('active');
  });

  it('does NOT retire when the source room is dark (no vision)', () => {
    const m = createTransportMission('W42N59', 'W43N58', TRANSPORT_DRAIN_ALL);
    (Game as any).rooms = {}; // source not visible
    (Game as any).creeps = {};
    syncTransportMission(m.id);
    expect(m.status).toBe('active');
  });

  it('GC keeps a retiring transport with live couriers, deletes once drained and aged', () => {
    const m = createTransportMission('W42N59', 'W43N58', 100000);
    m.status = 'retiring';
    m.createdAt = (Game as any).time - 400; // older than the 300-tick GC age
    m.courierIds = ['c1'];
    garbageCollectMissions();
    expect(getTransportMission(m.id)).toBeDefined(); // live courier → kept

    m.courierIds = [];
    garbageCollectMissions();
    expect(getTransportMission(m.id)).toBeUndefined(); // drained + aged → reclaimed
  });
});
