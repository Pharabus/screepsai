import { resetGameGlobals } from '../mocks/screeps';
import {
  scoreClaimTarget,
  canClaimAnotherRoom,
  startClaim,
  ownedRoomCount,
  coloniesForHome,
  updateColonyStates,
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

    it('flips bootstrapping → active when a spawn exists AND a local producer is alive', () => {
      Game.time = 700;
      Memory.colonies = {
        W2N1: { homeRoom: 'W1N1', status: 'bootstrapping', selectedAt: 100, claimedAt: 200 },
      };
      Game.rooms['W2N1'] = {
        name: 'W2N1',
        controller: { my: true },
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
