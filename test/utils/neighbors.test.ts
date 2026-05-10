import { resetGameGlobals, mockCreep, mockRoom } from '../mocks/screeps';
import {
  recordHostile,
  getNeighbor,
  hostilesSeen,
  summarizeNeighbors,
} from '../../src/utils/neighbors';
import { flushSegments } from '../../src/utils/segments';

// Each test uses a fresh Game.time so the segment tick-cache resets
let tick = 100;

beforeEach(() => {
  resetGameGlobals();
  tick += 100;
  (Game as any).time = tick;
});

describe('neighbors', () => {
  describe('recordHostile', () => {
    it('creates a new record on first sighting', () => {
      const creep = mockCreep({
        owner: { username: 'Attacker' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      const room = mockRoom({ name: 'W1N1' });

      recordHostile(creep, room);

      const rec = getNeighbor('Attacker');
      expect(rec).toBeDefined();
      expect(rec!.attacks).toBe(1);
      expect(rec!.seenRooms).toContain('W1N1');
      expect(rec!.maxThreatScore).toBe(80);
    });

    it('accumulates attacks on repeat sightings', () => {
      const creep = mockCreep({
        owner: { username: 'Bully' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      const room = mockRoom({ name: 'W1N1' });

      recordHostile(creep, room);
      flushSegments(); // persist segment before advancing tick
      (Game as any).time = tick + 1;
      recordHostile(creep, room);

      const rec = getNeighbor('Bully');
      expect(rec!.attacks).toBe(2);
    });

    it('skips creeps without an owner', () => {
      const creep = mockCreep({
        owner: undefined,
        body: [{ type: ATTACK, hits: 100 }],
      });
      const room = mockRoom({ name: 'W1N1' });
      recordHostile(creep, room);
      // No crash — just nothing stored (no owner.username)
    });

    it('does not increment attacks for zero-threat creeps (scouts)', () => {
      const scout = mockCreep({
        owner: { username: 'Scout' },
        body: [{ type: MOVE, hits: 100 }],
      });
      const room = mockRoom({ name: 'W1N1' });

      recordHostile(scout, room);

      const rec = getNeighbor('Scout');
      expect(rec!.attacks).toBe(0);
    });
  });

  describe('hostility classification', () => {
    it('classifies as passive when no attacks', () => {
      const scout = mockCreep({
        owner: { username: 'Passive' },
        body: [{ type: MOVE, hits: 100 }],
      });
      recordHostile(scout, mockRoom({ name: 'W1N1' }));
      expect(getNeighbor('Passive')!.hostility).toBe('passive');
    });

    it('classifies as aggressive after 3+ attacks', () => {
      const creep = mockCreep({
        owner: { username: 'Griefer' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      const room = mockRoom({ name: 'W1N1' });
      for (let i = 0; i < 3; i++) {
        (Game as any).time = tick + i;
        recordHostile(creep, room);
        flushSegments(); // persist between fake ticks
      }
      expect(getNeighbor('Griefer')!.hostility).toBe('aggressive');
    });

    it('classifies as aggressive when maxThreatScore >= 500', () => {
      // HEAL=250, RANGED_ATTACK=150, ATTACK=80 → 480; add another HEAL → 730
      const creep = mockCreep({
        owner: { username: 'Whale' },
        body: [
          { type: HEAL, hits: 100 },
          { type: HEAL, hits: 100 },
          { type: RANGED_ATTACK, hits: 100 },
        ],
      });
      recordHostile(creep, mockRoom({ name: 'W1N1' }));
      const rec = getNeighbor('Whale');
      expect(rec!.maxThreatScore).toBeGreaterThanOrEqual(500);
      expect(rec!.hostility).toBe('aggressive');
    });

    it('classifies as unknown for moderate threat', () => {
      // One attack = score 80, one sighting → attacks=1 < 3, score < 500
      const creep = mockCreep({
        owner: { username: 'Mystery' },
        body: [
          { type: ATTACK, hits: 100 },
          { type: RANGED_ATTACK, hits: 100 },
        ],
      });
      recordHostile(creep, mockRoom({ name: 'W1N1' }));
      expect(getNeighbor('Mystery')!.hostility).toBe('unknown');
    });
  });

  describe('hostilesSeen', () => {
    it('returns players seen in a specific room', () => {
      const creep = mockCreep({
        owner: { username: 'Raider' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      recordHostile(creep, mockRoom({ name: 'W2N2' }));

      const seen = hostilesSeen('W2N2');
      expect(seen).toContain('Raider');
    });

    it('does not return players not seen in that room', () => {
      const creep = mockCreep({
        owner: { username: 'OtherRoom' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      recordHostile(creep, mockRoom({ name: 'W3N3' }));

      const seen = hostilesSeen('W2N2');
      expect(seen).not.toContain('OtherRoom');
    });

    it('excludes entries older than maxAgeTicks', () => {
      const creep = mockCreep({
        owner: { username: 'Ancient' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      recordHostile(creep, mockRoom({ name: 'W1N1' }));

      // Advance time beyond maxAge
      (Game as any).time = tick + 100_000;
      const seen = hostilesSeen('W1N1', 1000);
      expect(seen).not.toContain('Ancient');
    });
  });

  describe('summarizeNeighbors', () => {
    it('returns no-data message when empty', () => {
      const result = summarizeNeighbors();
      expect(result).toContain('No hostile players');
    });

    it('includes player name and hostility in output', () => {
      const creep = mockCreep({
        owner: { username: 'BigBad' },
        body: [{ type: ATTACK, hits: 100 }],
      });
      recordHostile(creep, mockRoom({ name: 'W1N1' }));

      const result = summarizeNeighbors();
      expect(result).toContain('BigBad');
    });
  });
});
