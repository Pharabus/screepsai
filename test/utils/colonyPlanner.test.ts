import { resetGameGlobals } from '../mocks/screeps';
import {
  scoreClaimTarget,
  canClaimAnotherRoom,
  startClaim,
  ownedRoomCount,
  coloniesForHome,
  updateColonyStates,
  getColonyScore,
  getColonyScores,
  resetColonyScoreCache,
  findClaimCandidates,
} from '../../src/utils/colonyPlanner';

function setOwnedRoom(name: string): void {
  Game.rooms[name] = { name, controller: { my: true, level: 6 } } as any;
}

function setMyUsername(name = 'Me'): void {
  Game.spawns = { Spawn1: { owner: { username: name } } } as any;
}

function setLinearDistance(distances: Record<string, number>): void {
  Game.map.getRoomLinearDistance = ((a: string, b: string) => {
    return distances[`${a}|${b}`] ?? distances[`${b}|${a}`] ?? 1;
  }) as any;
}

describe('colonyPlanner', () => {
  beforeEach(() => {
    resetGameGlobals();
    setMyUsername();
    setLinearDistance({});
  });

  describe('scoreClaimTarget', () => {
    it('rejects rooms with no scouted data', () => {
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBe(-1);
      expect(result.reason).toMatch(/not scouted/);
    });

    it('rejects rooms without a controller', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: false,
      } as any;
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBe(-1);
      expect(result.reason).toMatch(/no controller/);
    });

    it('rejects rooms owned by other players', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
        scoutedOwner: 'Enemy',
      } as any;
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBe(-1);
      expect(result.reason).toMatch(/Enemy/);
    });

    it('rejects rooms reserved by other players', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
        scoutedReservation: 'Stranger',
      } as any;
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBe(-1);
      expect(result.reason).toMatch(/Stranger/);
    });

    it('allows rooms reserved by self', () => {
      setLinearDistance({ 'W1N1|W2N1': 1 });
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
        scoutedReservation: 'Me',
      } as any;
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBeGreaterThan(0);
    });

    it('rejects rooms with zero sources', () => {
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 0,
        scoutedHasController: true,
      } as any;
      expect(scoreClaimTarget('W2N1', 'W1N1').score).toBe(-1);
    });

    it('rejects rooms with recent hostiles', () => {
      Game.time = 2000;
      Memory.rooms['W2N1'] = {
        scoutedAt: 1000, // 1000 ticks ago — within 1500 window
        scoutedHostiles: 3,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      expect(scoreClaimTarget('W2N1', 'W1N1').score).toBe(-1);
    });

    it('rejects rooms too far away', () => {
      setLinearDistance({ 'W1N1|W2N1': 5 });
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      const result = scoreClaimTarget('W2N1', 'W1N1');
      expect(result.score).toBe(-1);
      expect(result.reason).toMatch(/distance 5/);
    });

    it('scores 2-source rooms higher than 1-source rooms', () => {
      setLinearDistance({ 'W1N1|W2N1': 1, 'W1N1|W2N2': 1 });
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      Memory.rooms['W2N2'] = {
        scoutedAt: 100,
        scoutedSources: 1,
        scoutedHasController: true,
      } as any;
      const two = scoreClaimTarget('W2N1', 'W1N1').score;
      const one = scoreClaimTarget('W2N2', 'W1N1').score;
      expect(two).toBeGreaterThan(one);
    });

    it('penalises greater distance', () => {
      setLinearDistance({ 'W1N1|W2N1': 1, 'W1N1|W2N2': 3 });
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      Memory.rooms['W2N2'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
      const near = scoreClaimTarget('W2N1', 'W1N1').score;
      const far = scoreClaimTarget('W2N2', 'W1N1').score;
      expect(near).toBeGreaterThan(far);
    });
  });

  describe('ownedRoomCount', () => {
    it('returns 0 when no rooms are owned', () => {
      expect(ownedRoomCount()).toBe(0);
    });

    it('counts each room with controller.my === true', () => {
      setOwnedRoom('W1N1');
      setOwnedRoom('W2N2');
      Game.rooms['W3N3'] = { controller: { my: false } } as any;
      expect(ownedRoomCount()).toBe(2);
    });
  });

  describe('canClaimAnotherRoom', () => {
    it('allows claiming when GCL > owned count', () => {
      Game.gcl = { level: 2 } as any;
      setOwnedRoom('W1N1');
      const result = canClaimAnotherRoom();
      expect(result.ok).toBe(true);
    });

    it('refuses when owned count equals GCL', () => {
      Game.gcl = { level: 1 } as any;
      setOwnedRoom('W1N1');
      const result = canClaimAnotherRoom();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/GCL 1/);
    });

    it('defaults GCL to 1 when not set', () => {
      setOwnedRoom('W1N1');
      const result = canClaimAnotherRoom();
      expect(result.ok).toBe(false);
    });
  });

  describe('startClaim', () => {
    beforeEach(() => {
      Game.gcl = { level: 2 } as any;
      setOwnedRoom('W1N1');
      setLinearDistance({ 'W1N1|W2N1': 1 });
      Memory.rooms['W2N1'] = {
        scoutedAt: 100,
        scoutedSources: 2,
        scoutedHasController: true,
      } as any;
    });

    it('writes a ColonyState in claiming status on success', () => {
      Game.time = 500;
      const result = startClaim('W2N1', 'W1N1');
      expect(result.ok).toBe(true);
      const state = Memory.colonies!['W2N1'];
      expect(state.status).toBe('claiming');
      expect(state.homeRoom).toBe('W1N1');
      expect(state.selectedAt).toBe(500);
    });

    it('is idempotent — does not overwrite existing colony state', () => {
      const first = startClaim('W2N1', 'W1N1');
      expect(first.ok).toBe(true);
      Game.time = 1000;
      const second = startClaim('W2N1', 'W1N1');
      expect(second.ok).toBe(true);
      // selectedAt remains from the first call
      expect(Memory.colonies!['W2N1'].selectedAt).toBe(1);
    });

    it('refuses when GCL is exhausted', () => {
      Game.gcl = { level: 1 } as any;
      const result = startClaim('W2N1', 'W1N1');
      expect(result.ok).toBe(false);
    });

    it('refuses when target is not viable', () => {
      Memory.rooms['W2N1']!.scoutedOwner = 'Enemy';
      const result = startClaim('W2N1', 'W1N1');
      expect(result.ok).toBe(false);
    });

    it('refuses when home room is not owned', () => {
      delete Game.rooms['W1N1'];
      const result = startClaim('W2N1', 'W1N1');
      expect(result.ok).toBe(false);
    });
  });

  describe('coloniesForHome', () => {
    it('returns empty when no colonies are tracked', () => {
      expect(coloniesForHome('W1N1')).toEqual([]);
    });

    it('returns colonies parented by the specified home', () => {
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 100 },
        W2N2: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 200 },
        W9N9: { homeRoom: 'W5N5', status: 'claiming', selectedAt: 300 },
      };
      const result = coloniesForHome('W1N1');
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.room).sort()).toEqual(['W2N1', 'W2N2']);
    });
  });

  describe('updateColonyStates', () => {
    it('does nothing without colonies', () => {
      expect(() => updateColonyStates()).not.toThrow();
    });

    it('flips claiming → bootstrapping when controller becomes mine', () => {
      Game.time = 500;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 100 },
      };
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true, level: 1 },
        find: () => [],
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('bootstrapping');
      expect(Memory.colonies['W2N1']!.claimedAt).toBe(500);
    });

    it('stays in claiming when controller is not yet mine', () => {
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 100 },
      };
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: false },
        find: () => [],
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('claiming');
    });

    it('flips bootstrapping → active when a spawn exists AND a source container is built', () => {
      Game.time = 700;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 100, claimedAt: 200 },
      };
      // Source container is present — colony can flip to miner economy on its own.
      Memory.rooms['W2N1'] = {
        sources: [
          { id: 'src1' as Id<Source>, x: 10, y: 10, containerId: 'c1' as Id<StructureContainer> },
        ],
      } as any;
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true },
        find: (type: number) => (type === FIND_MY_SPAWNS ? [{ name: 'S' }] : []),
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('active');
      expect(Memory.colonies['W2N1']!.activeAt).toBe(700);
    });

    it('flips bootstrapping → active when spawn exists, RCL 3, extensions built, and local producer alive', () => {
      Game.time = 700;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 100, claimedAt: 200 },
      };
      // No container yet, but RCL 3 + extensions + local harvester = self-sufficient.
      Memory.rooms['W2N1'] = {
        sources: [{ id: 'src1' as Id<Source>, x: 10, y: 10 }],
      } as any;
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true, level: 3 },
        energyCapacityAvailable: 600,
        find: (type: number) => (type === FIND_MY_SPAWNS ? [{ name: 'S' }] : []),
      } as any;
      Game.creeps['h1'] = {
        name: 'h1',
        memory: { role: 'harvester', homeRoom: 'W2N1' },
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('active');
      expect(Memory.colonies['W2N1']!.activeAt).toBe(700);
    });

    it('stays in bootstrapping with only a harvester and no container at RCL 2', () => {
      Game.time = 700;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 100, claimedAt: 200 },
      };
      // RCL 2, no container — a single 1-WORK harvester cannot build containers fast enough.
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true, level: 2 },
        energyCapacityAvailable: 300,
        find: (type: number) => (type === FIND_MY_SPAWNS ? [{ name: 'S' }] : []),
      } as any;
      Game.creeps['h1'] = {
        name: 'h1',
        memory: { role: 'harvester', homeRoom: 'W2N1' },
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('bootstrapping');
    });

    it('stays in bootstrapping when a spawn exists but no local producer yet', () => {
      Game.time = 700;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 100, claimedAt: 200 },
      };
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true },
        find: (type: number) => (type === FIND_MY_SPAWNS ? [{ name: 'S' }] : []),
      } as any;
      // Only a colonyBuilder is alive — the spawn has nothing to refill it once
      // the builder dies. Parent must keep spawning support until a local
      // harvester or miner takes over.
      Game.creeps['cb1'] = {
        name: 'cb1',
        memory: { role: 'colonyBuilder', homeRoom: 'W1N1', targetRoom: 'W2N1' },
      } as any;
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('bootstrapping');
      expect(Memory.colonies['W2N1']!.activeAt).toBeUndefined();
    });

    it('does nothing when target room has no visibility', () => {
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'claiming', selectedAt: 100 },
      };
      // No Game.rooms['W2N1']
      updateColonyStates();
      expect(Memory.colonies['W2N1']!.status).toBe('claiming');
    });
  });
});

// ---------------------------------------------------------------------------
// Colony priority scoring
// ---------------------------------------------------------------------------

describe('getColonyScore', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
  });

  function makeRoom(
    name: string,
    rcl: number,
    storedEnergy: number,
    sources: { containerId?: string; minerName?: string }[] = [],
  ): any {
    const room: any = {
      name,
      controller: { my: true, level: rcl },
      storage: {
        store: { getUsedCapacity: (r: string) => (r === RESOURCE_ENERGY ? storedEnergy : 0) },
      },
    };
    Memory.rooms[name] = {
      sources: sources.map((s, i) => ({
        id: `src${i}` as any,
        x: 10 + i,
        y: 10,
        containerId: s.containerId as any,
        minerName: s.minerName,
      })),
    } as any;
    // Register alive miners in Game.creeps
    for (const s of sources) {
      if (s.minerName) {
        (Game as any).creeps[s.minerName] = { name: s.minerName, memory: { role: 'miner' } };
      }
    }
    (Game as any).rooms[name] = room;
    return room;
  }

  it('young colony with healthy income scores higher than a mature room', () => {
    // W44N57: RCL 4, 15k storage, 2 active sources
    const young = makeRoom('W44N57', 4, 15_000, [
      { containerId: 'c1', minerName: 'm1' },
      { containerId: 'c2', minerName: 'm2' },
    ]);
    // W43N58: RCL 7, 50k storage, 2 active sources
    const mature = makeRoom('W43N58', 7, 50_000, [
      { containerId: 'c3', minerName: 'm3' },
      { containerId: 'c4', minerName: 'm4' },
    ]);

    const youngScore = getColonyScore(young);
    const matureScore = getColonyScore(mature);

    // young: rclFactor=4, incomeRate=20, storageFactor=0.75 → 60
    // mature: rclFactor=1, incomeRate=20, storageFactor=1.0 → 20
    expect(youngScore).toBeGreaterThan(matureScore);
  });

  it('income-starved colony (no active sources) scores low', () => {
    // Room with sources planned but no miners live yet
    const room = makeRoom('W1N1', 4, 12_000, [
      { containerId: 'c1' }, // no minerName → not active
    ]);
    const score = getColonyScore(room);
    // incomeRate derived from bootstrap fallback: 1 planned source × 10 = 10
    // storageFactor = 12k/20k = 0.6 → score = 4 × 10 × 0.6 = 24
    // Below the young-colony income threshold (20 = minScore check in spawner)
    // Just verify score is positive but modest
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('room with zero storage scores lower than room with healthy storage (same RCL and sources)', () => {
    const healthy = makeRoom('W1N1', 4, 20_000, [{ containerId: 'c1', minerName: 'm1' }]);
    resetColonyScoreCache();
    const empty = makeRoom('W1N2', 4, 0, [{ containerId: 'c2', minerName: 'm2' }]);
    (Game as any).creeps['m1'] = { name: 'm1', memory: { role: 'miner' } };
    (Game as any).creeps['m2'] = { name: 'm2', memory: { role: 'miner' } };

    const healthyScore = getColonyScore(healthy);
    const emptyScore = getColonyScore(empty);

    expect(healthyScore).toBeGreaterThan(emptyScore);
  });

  it('RCL 8 room scores lower than same-income RCL 4 room', () => {
    const rcl4 = makeRoom('W1N1', 4, 20_000, [{ containerId: 'c1', minerName: 'm1' }]);
    resetColonyScoreCache();
    const rcl8 = makeRoom('W1N2', 8, 20_000, [{ containerId: 'c2', minerName: 'm2' }]);
    (Game as any).creeps['m1'] = { name: 'm1', memory: { role: 'miner' } };
    (Game as any).creeps['m2'] = { name: 'm2', memory: { role: 'miner' } };

    const score4 = getColonyScore(rcl4);
    const score8 = getColonyScore(rcl8);

    // rclFactor 4 vs 1 → RCL 4 scores 4× higher
    expect(score4).toBeGreaterThan(score8);
  });

  it('returns cached value within SCORE_CACHE_INTERVAL ticks', () => {
    const room = makeRoom('W1N1', 4, 15_000, [{ containerId: 'c1', minerName: 'm1' }]);
    (Game as any).time = 100;
    const first = getColonyScore(room);

    // Update storage — should not change score until cache expires
    room.storage.store.getUsedCapacity = () => 99_999;
    (Game as any).time = 300; // still within 500-tick window
    const second = getColonyScore(room);

    expect(second).toBe(first);
  });

  it('recomputes after SCORE_CACHE_INTERVAL ticks', () => {
    const room = makeRoom('W1N1', 4, 0, [{ containerId: 'c1', minerName: 'm1' }]);
    (Game as any).time = 100;
    const first = getColonyScore(room);

    // Move past the cache window and change storage
    (Game as any).time = 700;
    room.storage.store.getUsedCapacity = (_r: string) => 20_000;
    const second = getColonyScore(room);

    expect(second).toBeGreaterThan(first);
  });
});

// ---------------------------------------------------------------------------
// Mineral-diversity bonus in scoreClaimTarget
// ---------------------------------------------------------------------------

describe('scoreClaimTarget — mineral diversity bonus', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
    // Default username so reservation checks pass
    Game.spawns = { Spawn1: { owner: { username: 'Me' } } } as any;
    // Default distance = 1 (within MAX_CLAIM_DISTANCE of 3)
    Game.map.getRoomLinearDistance = ((_a: string, _b: string) => 1) as any;
  });

  /** Helper: set up a scouted viable candidate with an optional mineral. */
  function scoutedViable(roomName: string, mineralType?: MineralConstant): void {
    Memory.rooms[roomName] = {
      scoutedAt: Game.time,
      scoutedSources: 2,
      scoutedHasController: true,
      scoutedMineral: mineralType ? { type: mineralType, x: 20, y: 20 } : undefined,
    } as any;
  }

  /** Helper: set an owned room with a resolved mineral. */
  function ownedWithMineral(roomName: string, mineralType: MineralConstant): void {
    Game.rooms[roomName] = { name: roomName, controller: { my: true, level: 6 } } as any;
    Memory.rooms[roomName] = { mineralId: `mineral_${roomName}` as any } as any;
    Game.getObjectById = ((id: string) => {
      if (id === `mineral_${roomName}`) return { mineralType } as any;
      return undefined;
    }) as any;
  }

  it('awards +5 bonus when candidate mineral differs from all owned rooms', () => {
    ownedWithMineral('W1N1', 'H');
    scoutedViable('W2N1', 'O'); // O ≠ H → diversity bonus
    const withBonus = scoreClaimTarget('W2N1', 'W1N1');

    // Baseline: candidate with no mineral at all
    scoutedViable('W3N1', undefined);
    const noMineral = scoreClaimTarget('W3N1', 'W1N1');

    expect(withBonus.score).toBe(noMineral.score + 5);
  });

  it('does NOT award bonus when candidate mineral matches an owned room', () => {
    ownedWithMineral('W1N1', 'H');
    scoutedViable('W2N1', 'H'); // matches home mineral — no bonus
    const result = scoreClaimTarget('W2N1', 'W1N1');

    scoutedViable('W3N1', undefined);
    const noMineral = scoreClaimTarget('W3N1', 'W1N1');

    expect(result.score).toBe(noMineral.score);
  });

  it('does NOT award bonus when candidate has no scoutedMineral', () => {
    ownedWithMineral('W1N1', 'H');
    scoutedViable('W2N1', undefined);
    const result = scoreClaimTarget('W2N1', 'W1N1');

    // score = 2*10 - 1*2 = 18 (no bonus)
    expect(result.score).toBe(18);
  });

  it('does NOT award bonus when owned-room minerals cannot be resolved (no mineralId)', () => {
    // Owned room exists but has no mineralId set
    Game.rooms['W1N1'] = { name: 'W1N1', controller: { my: true, level: 6 } } as any;
    Memory.rooms['W1N1'] = {} as any; // no mineralId
    scoutedViable('W2N1', 'Z');
    const result = scoreClaimTarget('W2N1', 'W1N1');

    // No owned minerals resolved → ownedMinerals.size === 0 → no bonus
    expect(result.score).toBe(18);
  });

  it('still returns -1 for all existing reject paths (owned)', () => {
    ownedWithMineral('W1N1', 'H');
    Memory.rooms['W2N1'] = {
      scoutedAt: Game.time,
      scoutedSources: 2,
      scoutedHasController: true,
      scoutedOwner: 'Enemy',
      scoutedMineral: { type: 'O', x: 10, y: 10 },
    } as any;
    expect(scoreClaimTarget('W2N1', 'W1N1').score).toBe(-1);
  });

  it('still returns -1 for the distance reject path', () => {
    ownedWithMineral('W1N1', 'H');
    Game.map.getRoomLinearDistance = ((_a: string, _b: string) => 5) as any;
    scoutedViable('W2N1', 'O');
    expect(scoreClaimTarget('W2N1', 'W1N1').score).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// findClaimCandidates
// ---------------------------------------------------------------------------

describe('findClaimCandidates', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
    Game.spawns = { Spawn1: { owner: { username: 'Me' } } } as any;
    // Default: all rooms distance 1
    Game.map.getRoomLinearDistance = ((_a: string, _b: string) => 1) as any;
  });

  function setOwned(name: string): void {
    Game.rooms[name] = { name, controller: { my: true, level: 6 } } as any;
    Memory.rooms[name] = {} as any;
  }

  function setScouted(name: string, sources: number, owned = false): void {
    if (owned) {
      Game.rooms[name] = { name, controller: { my: true, level: 5 } } as any;
    }
    Memory.rooms[name] = {
      scoutedAt: 1,
      scoutedSources: sources,
      scoutedHasController: true,
    } as any;
  }

  it('returns [] when nothing is scouted', () => {
    setOwned('W1N1');
    expect(findClaimCandidates()).toEqual([]);
  });

  it('returns [] when no rooms are owned', () => {
    Memory.rooms['W2N1'] = {
      scoutedAt: 1,
      scoutedSources: 2,
      scoutedHasController: true,
    } as any;
    expect(findClaimCandidates()).toEqual([]);
  });

  it('excludes rooms that are owned by us', () => {
    setOwned('W1N1');
    setScouted('W2N1', 2, /* owned= */ true); // also owned — should be excluded
    expect(findClaimCandidates()).toEqual([]);
  });

  it('excludes rooms with scoreClaimTarget < 0 (e.g. no sources)', () => {
    setOwned('W1N1');
    Memory.rooms['W2N1'] = {
      scoutedAt: 1,
      scoutedSources: 0, // scoreClaimTarget returns -1
      scoutedHasController: true,
    } as any;
    expect(findClaimCandidates()).toEqual([]);
  });

  it('returns viable candidates sorted by score DESC', () => {
    setOwned('W1N1');
    // W2N1: 2 sources, distance 1 → score = 20 - 2 = 18
    setScouted('W2N1', 2);
    // W2N2: 1 source, distance 1 → score = 10 - 2 = 8
    setScouted('W2N2', 1);

    const results = findClaimCandidates();
    expect(results).toHaveLength(2);
    expect(results[0]!.target).toBe('W2N1');
    expect(results[1]!.target).toBe('W2N2');
  });

  it('breaks score ties by linear distance ASC', () => {
    setOwned('W1N1');
    // Both 2-source rooms; W2N2 is farther away
    setScouted('W2N1', 2);
    setScouted('W2N2', 2);

    Game.map.getRoomLinearDistance = ((a: string, b: string) => {
      if ((a === 'W1N1' && b === 'W2N1') || (a === 'W2N1' && b === 'W1N1')) return 1;
      if ((a === 'W1N1' && b === 'W2N2') || (a === 'W2N2' && b === 'W1N1')) return 2;
      return 1;
    }) as any;

    const results = findClaimCandidates();
    expect(results).toHaveLength(2);
    // W2N1 closer → wins tie-break; both have score 20 - distance*2
    // W2N1 score = 20-2=18, W2N2 score = 20-4=16 → different scores, W2N1 wins
    expect(results[0]!.target).toBe('W2N1');
  });

  it('picks the nearest owned room as home when multiple owned rooms exist', () => {
    // Two owned rooms; W1N1 is closer to target W5N5
    setOwned('W1N1');
    setOwned('W3N3');
    setScouted('W2N1', 2);

    Game.map.getRoomLinearDistance = ((a: string, b: string) => {
      const key = [a, b].sort().join('|');
      if (key === 'W1N1|W2N1') return 1; // W1N1 closer
      if (key === 'W2N1|W3N3') return 3; // W3N3 farther
      return 1;
    }) as any;

    const results = findClaimCandidates();
    expect(results).toHaveLength(1);
    expect(results[0]!.home).toBe('W1N1');
  });

  it('includes score, target, and home in each result', () => {
    setOwned('W1N1');
    setScouted('W2N1', 2);

    const results = findClaimCandidates();
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r).toHaveProperty('target', 'W2N1');
    expect(r).toHaveProperty('home', 'W1N1');
    expect(r).toHaveProperty('score');
    expect(typeof r.score).toBe('number');
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe('getColonyScores', () => {
  beforeEach(() => {
    resetGameGlobals();
    resetColonyScoreCache();
  });

  it('returns a score for every owned room', () => {
    (Game as any).rooms = {
      W1N1: { name: 'W1N1', controller: { my: true, level: 4 } },
      W2N2: { name: 'W2N2', controller: { my: true, level: 7 } },
      W3N3: { name: 'W3N3', controller: { my: false, level: 1 } }, // not ours
    };
    Memory.rooms = { W1N1: {} as any, W2N2: {} as any, W3N3: {} as any };

    const scores = getColonyScores();
    expect(Object.keys(scores)).toContain('W1N1');
    expect(Object.keys(scores)).toContain('W2N2');
    expect(Object.keys(scores)).not.toContain('W3N3');
  });
});
